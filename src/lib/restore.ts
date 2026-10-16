import { read, write } from "@/lib/neo4j";
import { embedBatch, embeddingText, embeddingHash, EMBEDDING_MODEL, EMBEDDING_VERSION } from "@/lib/embeddings";
import { isRelType } from "@/lib/graph";
import { EXPORT_FORMAT, KNOWN_LABELS, TEMPORAL_KEYS, type ExportFile } from "@/lib/export";

/**
 * Restoring a graph from an export file.
 *
 * This deliberately does NOT go through `upsertConcept`. That function mints a
 * fresh `randomUUID` and resets the FSRS fields `ON CREATE` — so restoring
 * through it would appear to succeed while assigning new ids (breaking every
 * edge reference) and wiping every review schedule. A restore that quietly
 * throws away months of spaced-repetition state is the exact failure a backup
 * exists to prevent, so properties are written verbatim here instead.
 */

export interface RestoreResult {
  nodes: Record<string, number>;
  edges: number;
  reEmbedded: number;
  skippedEdges: number;
}

function splitTemporal(row: Record<string, unknown>): {
  props: Record<string, unknown>;
  temporal: Record<string, string>;
} {
  const props: Record<string, unknown> = {};
  const temporal: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue;
    if (TEMPORAL_KEYS.has(key) && typeof value === "string") {
      temporal[key] = value;
    } else {
      props[key] = value;
    }
  }
  return { props, temporal };
}

export async function restoreGraph(
  data: ExportFile,
  { reEmbed = true }: { reEmbed?: boolean } = {},
): Promise<RestoreResult> {
  if (data.format !== EXPORT_FORMAT) {
    throw new Error(
      `Unsupported export format "${data.format}" (expected "${EXPORT_FORMAT}").`,
    );
  }

  const result: RestoreResult = { nodes: {}, edges: 0, reEmbedded: 0, skippedEdges: 0 };

  // ── Nodes ──────────────────────────────────────────────────────────────────
  for (const label of KNOWN_LABELS) {
    const rows = data.nodes[label];
    if (!rows?.length) continue;

    const payload = rows.map((row) => {
      const { props, temporal } = splitTemporal(row);
      if (!props.id) {
        throw new Error(`Cannot restore a ${label} with no id: ${JSON.stringify(row).slice(0, 200)}`);
      }
      return { id: props.id, props, temporal };
    });

    // `SET n = row.props` REPLACES the property map, which is what makes this
    // idempotent: running the same file twice leaves identical nodes rather
    // than accumulating stale keys from a previous shape.
    //
    // Temporal values then go back as real datetimes. JSON has no datetime
    // type, so without this pass `due` would be restored as a string and every
    // comparison in the review queue would silently stop matching.
    await write(
      `
      UNWIND $rows AS row
      MERGE (n:${label} {id: row.id})
      SET n = row.props
      WITH n, row
      UNWIND CASE WHEN size(keys(row.temporal)) = 0 THEN [null]
                  ELSE keys(row.temporal) END AS key
      FOREACH (_ IN CASE WHEN key IS NULL THEN [] ELSE [1] END |
        SET n[key] = datetime(row.temporal[key])
      )
      `,
      { rows: payload },
    );
    result.nodes[label] = rows.length;
  }

  // ── Edges ──────────────────────────────────────────────────────────────────
  // Grouped by type because Cypher cannot parameterize a relationship type.
  // Each type is validated against the closed vocabulary before it reaches the
  // query string, exactly as linkConcepts does.
  const byType = new Map<string, ExportFile["edges"]>();
  for (const edge of data.edges) {
    if (!isRelType(edge.type)) {
      throw new Error(
        `Export contains relationship type "${edge.type}", which is not in the ` +
          `vocabulary. Refusing to restore rather than inventing a type.`,
      );
    }
    const list = byType.get(edge.type) ?? [];
    list.push(edge);
    byType.set(edge.type, list);
  }

  for (const [type, edges] of byType) {
    const payload = edges.map((e) => {
      const { props, temporal } = splitTemporal(e.props ?? {});
      return { from: e.from, to: e.to, props, temporal };
    });

    const res = await write(
      `
      UNWIND $rows AS row
      MATCH (a {id: row.from})
      MATCH (b {id: row.to})
      MERGE (a)-[r:${type}]->(b)
      SET r = row.props
      WITH r, row
      UNWIND CASE WHEN size(keys(row.temporal)) = 0 THEN [null]
                  ELSE keys(row.temporal) END AS key
      FOREACH (_ IN CASE WHEN key IS NULL THEN [] ELSE [1] END |
        SET r[key] = datetime(row.temporal[key])
      )
      RETURN count(DISTINCT r) AS n
      `,
      { rows: payload },
    );
    const written = res.records[0]?.get("n")?.toNumber?.() ?? 0;
    result.edges += written;
    // MATCH silently drops a row whose endpoints are missing, so compare and
    // report rather than letting edges vanish quietly.
    result.skippedEdges += edges.length - written;
  }

  // ── Embeddings ─────────────────────────────────────────────────────────────
  // Excluded from the export by default because they are derived. Recomputing
  // them is what makes the restore complete: without this the graph reads fine
  // and has silently lost semantic search.
  if (reEmbed) {
    result.reEmbedded = await reEmbedMissing();
  }

  return result;
}

/**
 * Embed every concept that has no vector, in batches.
 *
 * Also the body of `scripts/reembed.mjs` for a model change: clear the
 * embeddings, bump EMBEDDING_VERSION, run this.
 */
export async function reEmbedMissing(batchSize = 32): Promise<number> {
  let total = 0;

  for (;;) {
    const pending = await read(
      `
      MATCH (c:Concept)
      WHERE c.embedding IS NULL
      RETURN c.id AS id, c.name AS name, c.aliases AS aliases, c.body AS body
      LIMIT toInteger($limit)
      `,
      { limit: batchSize },
    );
    if (pending.records.length === 0) break;

    const rows = pending.records.map((r) => ({
      id: String(r.get("id")),
      text: embeddingText({
        name: String(r.get("name")),
        aliases: (r.get("aliases") as string[]) ?? [],
        body: (r.get("body") as string) ?? "",
      }),
    }));

    const vectors = await embedBatch(rows.map((r) => r.text));

    await write(
      `
      UNWIND $rows AS row
      MATCH (c:Concept {id: row.id})
      SET c.embedding        = row.embedding,
          c.textHash         = row.textHash,
          c.embeddingModel   = $model,
          c.embeddingVersion = $version
      `,
      {
        rows: rows.map((r, i) => ({
          id: r.id,
          embedding: vectors[i],
          textHash: embeddingHash(r.text),
        })),
        model: EMBEDDING_MODEL,
        version: EMBEDDING_VERSION,
      },
    );

    total += rows.length;
  }

  return total;
}
