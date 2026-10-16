import { read } from "@/lib/neo4j";
import { REL_TYPES } from "@/lib/graph";
import { EMBEDDING_MODEL, EMBEDDING_VERSION } from "@/lib/embeddings";

/**
 * Exporting the graph to a portable, version-independent file.
 *
 * This is the PRIMARY backup, not the fallback. `neo4j-admin database dump`
 * cannot run against a mounted database and online backup is Enterprise-only,
 * so every binary dump on Community costs downtime. A plain JSON export runs
 * online, survives a Neo4j major version it cannot start, and can be read by a
 * human or loaded into something that isn't Neo4j at all. For an asset that
 * cannot be rebuilt from a repo, that portability is worth more than restore
 * speed.
 */

export const EXPORT_FORMAT = "brain-export/1";

/**
 * Every node label this exporter knows how to write.
 *
 * The export ASSERTS that the labels actually present in the database are a
 * subset of this set, and fails loudly otherwise. That is the whole point: the
 * worst backup failure is not a missing file, it is a file that looks fine and
 * is quietly incomplete. When a later milestone adds a label, the backup stops
 * working until someone teaches it about the new data — which is a ten-second
 * fix, as opposed to discovering six months of silently omitted nodes at
 * exactly the moment you need them.
 */
export const KNOWN_LABELS = ["Concept", "Topic", "Source", "Ingest", "Inbox"] as const;

/**
 * Properties holding Neo4j temporal values.
 *
 * JSON has no datetime, so these are written as ISO strings and converted back
 * with `datetime()` on restore. Shared with restore.ts so the two cannot drift
 * — a mismatch here would restore review schedules as plain strings and break
 * every `due` comparison in the review queue.
 */
export const TEMPORAL_KEYS = new Set([
  "createdAt",
  "updatedAt",
  "due",
  "lastReview",
  "capturedAt",
  "reinforcedAt",
  "at",
]);

export interface ExportFile {
  format: string;
  exportedAt: string;
  neo4j: string;
  embeddingModel: string;
  embeddingVersion: number;
  embeddingsIncluded: boolean;
  counts: Record<string, number>;
  nodes: Record<string, Array<Record<string, unknown>>>;
  edges: Array<{
    from: string;
    to: string;
    type: string;
    props: Record<string, unknown>;
  }>;
}

/**
 * Convert driver values into JSON-safe plain ones.
 *
 * Integers arrive as {low, high} and temporals as objects with a toString that
 * produces ISO-8601. Writing either straight to JSON produces a file that
 * restores into garbage.
 */
function plain(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "object") {
    const v = value as { toNumber?: () => number; toString?: () => string };
    // neo4j Integer
    if (typeof v.toNumber === "function") return v.toNumber();
    // Temporal types (DateTime, Date, LocalDateTime, …) stringify to ISO-8601
    if (typeof v.toString === "function" && v.constructor?.name !== "Object") {
      return v.toString();
    }
    const out: Record<string, unknown> = {};
    for (const [k, nested] of Object.entries(value as Record<string, unknown>)) {
      out[k] = plain(nested);
    }
    return out;
  }
  return value;
}

/**
 * Fail unless every label and relationship type in the database is one this
 * exporter understands, and every node carries exactly one label.
 *
 * Counts come from a scan of the actual nodes rather than `db.labels()`, which
 * also reports labels left in the token store with no nodes behind them and
 * would produce spurious failures.
 */
async function assertCoverage(): Promise<void> {
  const labelResult = await read(
    "MATCH (n) UNWIND labels(n) AS label RETURN DISTINCT label ORDER BY label",
  );
  const present = labelResult.records.map((r) => r.get("label") as string);
  const unknown = present.filter(
    (l) => !(KNOWN_LABELS as readonly string[]).includes(l),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Export refuses to run: the graph contains ${unknown.length} label(s) ` +
        `this exporter does not know how to write — ${unknown.join(", ")}.\n` +
        `Add them to KNOWN_LABELS in src/lib/export.ts. Exporting without ` +
        `them would produce a backup that looks complete and silently is not.`,
    );
  }

  const multi = await read(
    "MATCH (n) WHERE size(labels(n)) <> 1 RETURN labels(n) AS labels LIMIT 5",
  );
  if (multi.records.length > 0) {
    const examples = multi.records.map((r) => (r.get("labels") as string[]).join("+"));
    throw new Error(
      `Export refuses to run: found node(s) with multiple labels ` +
        `(${examples.join("; ")}). The format writes each node under exactly ` +
        `one label, so these would be duplicated or lost on restore.`,
    );
  }

  const relResult = await read(
    "MATCH ()-[r]->() RETURN DISTINCT type(r) AS type ORDER BY type",
  );
  const relsPresent = relResult.records.map((r) => r.get("type") as string);
  const unknownRels = relsPresent.filter(
    (t) => !(REL_TYPES as readonly string[]).includes(t),
  );
  if (unknownRels.length > 0) {
    throw new Error(
      `Export refuses to run: the graph contains relationship type(s) outside ` +
        `the vocabulary — ${unknownRels.join(", ")}. Either add them to ` +
        `REL_TYPES in src/lib/graph.ts or clean them up; they indicate the ` +
        `closed vocabulary was bypassed somewhere.`,
    );
  }
}

/**
 * Read the whole graph into a portable object.
 *
 * Embeddings are excluded by default. They are DERIVED data — a restore
 * recomputes them from the same text and the same model in seconds — and
 * including them roughly quintuples the file for something that cannot outlive
 * the model version anyway. `withEmbeddings` exists for a byte-fidelity copy.
 */
export async function exportGraph(
  { withEmbeddings = false }: { withEmbeddings?: boolean } = {},
): Promise<ExportFile> {
  await assertCoverage();

  const version = await read("CALL dbms.components() YIELD versions RETURN versions[0] AS v");
  const neo4jVersion = String(version.records[0]?.get("v") ?? "unknown");

  const nodes: ExportFile["nodes"] = {};
  const counts: Record<string, number> = {};

  for (const label of KNOWN_LABELS) {
    // The label is a compile-time literal from KNOWN_LABELS, never caller
    // input, so interpolating it is safe — Cypher cannot parameterize a label.
    const result = await read(`MATCH (n:${label}) RETURN n ORDER BY n.id`);
    const rows = result.records.map((r) => {
      const props = (r.get("n") as { properties: Record<string, unknown> }).properties;
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(props)) {
        if (key === "embedding" && !withEmbeddings) continue;
        // Permissive about PROPERTIES on purpose, strict about labels: an
        // unrecognised property is written out rather than dropped, because
        // losing data is the harm a backup exists to prevent.
        out[key] = plain(value);
      }
      return out;
    });
    if (rows.length > 0) {
      nodes[label] = rows;
      counts[label] = rows.length;
    }
  }

  const edgeResult = await read(`
    MATCH (a)-[r]->(b)
    RETURN a.id AS from, b.id AS to, type(r) AS type, properties(r) AS props
    ORDER BY from, type, to
  `);
  const edges = edgeResult.records.map((r) => ({
    from: String(r.get("from")),
    to: String(r.get("to")),
    type: String(r.get("type")),
    props: plain(r.get("props")) as Record<string, unknown>,
  }));
  counts.edges = edges.length;

  // An edge whose endpoints have no id cannot be restored. Catch it here
  // rather than at 3am during a recovery.
  const dangling = edges.filter((e) => e.from === "null" || e.to === "null");
  if (dangling.length > 0) {
    throw new Error(
      `Export refuses to run: ${dangling.length} relationship(s) connect nodes ` +
        `without an id property, so they could not be restored.`,
    );
  }

  return {
    format: EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    neo4j: neo4jVersion,
    embeddingModel: EMBEDDING_MODEL,
    embeddingVersion: EMBEDDING_VERSION,
    embeddingsIncluded: withEmbeddings,
    counts,
    nodes,
    edges,
  };
}

/**
 * One markdown file per concept — the escape hatch.
 *
 * Guarantees a plain-text copy of prose you wrote that needs no Neo4j, no
 * importer and no JSON parser to read, and lands in a shape Obsidian or any
 * editor understands. The difference between a system you can leave and a trap.
 */
export function toMarkdownFiles(
  data: ExportFile,
): Array<{ filename: string; content: string }> {
  const concepts = data.nodes.Concept ?? [];
  const byId = new Map(concepts.map((c) => [String(c.id), c]));

  const linksFrom = new Map<string, Array<{ type: string; to: string }>>();
  for (const edge of data.edges) {
    if (!byId.has(edge.from)) continue;
    const list = linksFrom.get(edge.from) ?? [];
    list.push({ type: edge.type, to: edge.to });
    linksFrom.set(edge.from, list);
  }

  return concepts.map((c) => {
    const name = String(c.name ?? "untitled");
    const links = linksFrom.get(String(c.id)) ?? [];

    const front = [
      "---",
      `id: ${c.id}`,
      `name: ${JSON.stringify(name)}`,
      `aliases: ${JSON.stringify(c.aliases ?? [])}`,
      `tracked: ${Boolean(c.tracked)}`,
      c.due ? `due: ${c.due}` : null,
      `created: ${c.createdAt ?? ""}`,
      "---",
    ]
      .filter(Boolean)
      .join("\n");

    const body = String(c.body ?? "").trim();

    // Wiki-style links, so the folder works as an Obsidian vault as-is.
    const related = links.length
      ? "\n\n## Links\n\n" +
        links
          .map((l) => {
            const target = byId.get(l.to);
            const label = target ? String(target.name) : l.to;
            return `- ${l.type.toLowerCase().replace(/_/g, " ")} → [[${label}]]`;
          })
          .join("\n")
      : "";

    return {
      // Windows forbids \ / : * ? " < > | in filenames, and a concept name is
      // free text that will eventually contain one of them.
      filename: `${name.replace(/[\\/:*?"<>|]/g, "-").slice(0, 120)}.md`,
      content: `${front}\n\n# ${name}\n\n${body}${related}\n`,
    };
  });
}
