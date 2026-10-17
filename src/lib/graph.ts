import { randomUUID } from "node:crypto";
import { read, write, int } from "@/lib/neo4j";
import { embed, embeddingHash, embeddingText, EMBEDDING_MODEL, EMBEDDING_VERSION } from "@/lib/embeddings";

/**
 * The graph read/write API. Everything above this — the MCP tools, the
 * explorer, the review session — is a thin wrapper over what is here.
 */

// The relationship vocabulary lives in its own module so the explorer's
// client components can import it without pulling neo4j-driver into the
// browser bundle. Re-exported here because this is where callers expect it,
// and it remains the single source of truth the MCP tool enum derives from.
export { REL_TYPES, UNDIRECTED, isRelType, relLabel, type RelType } from "@/lib/rel-types";
import { REL_TYPES, isRelType, type RelType } from "@/lib/rel-types";

export interface Concept {
  id: string;
  name: string;
  aliases: string[];
  body: string;
  prompt: string | null;
  tracked: boolean;
  flagged: boolean;
  flagNote: string | null;
  createdAt: string;
  updatedAt: string;
  topics: string[];
}

export interface ScoredConcept {
  id: string;
  name: string;
  body: string;
  score: number;
  /** Which retrievers found it — useful for debugging a bad result set. */
  sources: string[];
}

export interface Edge {
  from: string;
  to: string;
  type: RelType;
  traversals: number;
  reinforcedAt: string | null;
}

/** Neo4j returns 64-bit integers as {low, high}; collapse them to JS numbers. */
function num(value: unknown): number {
  if (typeof value === "number") return value;
  if (value && typeof (value as { toNumber?: () => number }).toNumber === "function") {
    return (value as { toNumber: () => number }).toNumber();
  }
  return 0;
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

type ConceptProps = Record<string, unknown>;

function toConcept(props: ConceptProps, topics: string[] = []): Concept {
  return {
    id: String(props.id),
    name: String(props.name),
    aliases: (props.aliases as string[]) ?? [],
    body: (props.body as string) ?? "",
    prompt: str(props.prompt),
    tracked: Boolean(props.tracked),
    flagged: Boolean(props.flagged),
    flagNote: str(props.flagNote),
    createdAt: str(props.createdAt) ?? "",
    updatedAt: str(props.updatedAt) ?? "",
    topics,
  };
}

// ── Writes ───────────────────────────────────────────────────────────────────

export interface UpsertInput {
  name: string;
  aliases?: string[];
  body?: string;
  prompt?: string | null;
  topics?: string[];
  tracked?: boolean;
  ingestId?: string | null;
}

/**
 * Create a concept, or update the one that already has this name.
 *
 * Re-embeds only when the embedded text actually changed, which is what keeps
 * a "just flip tracked to true" update from paying for an inference.
 */
export async function upsertConcept(
  input: UpsertInput,
): Promise<{ id: string; created: boolean; reEmbedded: boolean }> {
  const name = input.name.trim();
  if (!name) throw new Error("Concept name cannot be empty");

  // Read the existing node first, because an upsert is a PARTIAL update:
  // a field the caller omitted means "leave it alone", never "clear it".
  //
  // This is not a nicety. `remember` is called from many independent
  // conversations, and a later one that mentions a concept without repeating
  // its aliases or body would otherwise erase what an earlier one wrote. The
  // plan's rule — merges append, they never overwrite — starts here.
  // Identity is case-insensitive. Without this "Raft" and "raft" are two
  // separate concepts — precisely the duplicate the dedupe handshake exists to
  // prevent, and the first one that shows up in practice once a model is
  // choosing the names. `name` remains the display form, first writer wins.
  const nameLower = name.toLocaleLowerCase();

  const existing = await read(
    `MATCH (c:Concept {nameLower: $nameLower})
     RETURN c.textHash AS hash, c.aliases AS aliases, c.body AS body,
            c.prompt AS prompt, c.revisions AS revisions`,
    { nameLower },
  );
  const prior = existing.records[0];

  const priorAliases = (prior?.get("aliases") as string[] | null) ?? [];
  const priorBody = (prior?.get("body") as string | null) ?? "";
  const priorPrompt = (prior?.get("prompt") as string | null) ?? null;
  const priorRevisions = (prior?.get("revisions") as string[] | null) ?? [];
  const currentHash = prior?.get("hash") as string | undefined;

  // Aliases accumulate: the same idea picking up another name is information,
  // and losing one silently breaks every future lookup that used it.
  const aliases = [...new Set([...priorAliases, ...(input.aliases ?? [])])];
  const body = input.body !== undefined && input.body !== "" ? input.body : priorBody;
  const prompt = input.prompt !== undefined ? input.prompt : priorPrompt;

  // Hash the MERGED text, not the caller's fragment — otherwise an update that
  // omits the body would re-embed the concept as if it had no body at all.
  const text = embeddingText({ name, aliases, body });
  const hash = embeddingHash(text);
  const needsEmbedding = currentHash !== hash;
  const embedding = needsEmbedding ? await embed(text) : null;

  // Keep the superseded body so an overwrite is recoverable. This is the only
  // lossy operation in the write path, and `update_concept` uses it to let
  // Claude rewrite an accreted note without that being a one-way door.
  //
  // Stored as JSON strings because a Neo4j property cannot hold a list of
  // maps — only primitives and arrays of primitives. A :Revision label would
  // be tidier in graph terms but would also have to be taught to the exporter,
  // and the history of a note is not something to traverse.
  const revisions =
    priorBody && body !== priorBody
      ? [JSON.stringify({ at: new Date().toISOString(), body: priorBody }), ...priorRevisions].slice(0, 5)
      : priorRevisions;

  // Distinguishes "this call created it" from "a previous, possibly crashed,
  // call left a marker behind" — a plain boolean flag could go stale.
  const nonce = randomUUID();

  const run = () =>
    write(
      `
      MERGE (c:Concept {nameLower: $nameLower})
      ON CREATE SET
        c.id        = randomUUID(),
        c.name      = $name,
        c.createdAt = datetime(),
        c.tracked   = false,
        c.flagged   = false,
        c.state     = 'new',
        c.reps      = 0,
        c.lapses    = 0,
        c.__nonce   = $nonce
      SET
        c.aliases   = $aliases,
        c.body      = $body,
        c.prompt    = $prompt,
        c.revisions = $revisions,
        c.updatedAt = datetime(),
        c.ingestId  = coalesce($ingestId, c.ingestId)
      // A null embedding means "unchanged, leave it alone". Plain SET would
      // write null and silently drop the vector, taking the concept out of
      // every future semantic search — so guard it with the FOREACH idiom
      // rather than setting it unconditionally.
      FOREACH (_ IN CASE WHEN $embedding IS NULL THEN [] ELSE [1] END |
        SET c.embedding        = $embedding,
            c.textHash         = $textHash,
            c.embeddingModel   = $model,
            c.embeddingVersion = $version
      )
      FOREACH (_ IN CASE WHEN $tracked IS NULL THEN [] ELSE [1] END |
        SET c.tracked = $tracked
      )
      WITH c, c.__nonce = $nonce AS wasCreated
      REMOVE c.__nonce
      WITH c, wasCreated
      CALL (c) {
        UNWIND $topics AS topicName
        MERGE (t:Topic {name: topicName})
          ON CREATE SET t.id = randomUUID()
        MERGE (c)-[:PART_OF]->(t)
      }
      RETURN c.id AS id, wasCreated
      `,
      {
        name,
        nameLower,
        aliases,
        body,
        prompt,
        revisions,
        nonce,
        topics: input.topics ?? [],
        tracked: input.tracked ?? null,
        ingestId: input.ingestId ?? null,
        embedding,
        textHash: hash,
        model: EMBEDDING_MODEL,
        version: EMBEDDING_VERSION,
      },
    );

  let result;
  try {
    result = await run();
  } catch (err) {
    // Two Claude clients (web and Claude Code) can call `remember` at the same
    // time. MERGE on a uniqueness-constrained property takes a lock, and the
    // loser gets a constraint violation rather than a duplicate node — which
    // is the behaviour we want, but it must not surface as a 500. By the time
    // we retry the node exists, so the same statement runs as a plain update.
    if (isConstraintViolation(err)) {
      result = await run();
    } else {
      throw err;
    }
  }

  const rec = result.records[0];
  return {
    id: String(rec.get("id")),
    created: Boolean(rec.get("wasCreated")),
    reEmbedded: needsEmbedding,
  };
}

function isConstraintViolation(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? "";
  return code.includes("ConstraintValidationFailed");
}

/**
 * Link two concepts.
 *
 * Cypher cannot parameterize a relationship type, so the type is interpolated
 * into the query string. That is only safe because `isRelType` has already
 * narrowed it to one of six compile-time literals — there is no path by which
 * caller input reaches the string unchecked.
 */
export async function linkConcepts(
  fromId: string,
  toId: string,
  type: RelType,
  props: { weight?: number; note?: string; ingestId?: string | null } = {},
): Promise<void> {
  if (!isRelType(type)) {
    throw new Error(
      `Unknown relationship type "${type}". Allowed: ${REL_TYPES.join(", ")}`,
    );
  }
  if (fromId === toId) {
    throw new Error("A concept cannot be linked to itself");
  }

  await write(
    `
    MATCH (a:Concept {id: $fromId})
    MATCH (b:Concept {id: $toId})
    MERGE (a)-[r:${type}]->(b)
      ON CREATE SET r.createdAt  = datetime(),
                    r.traversals = 0
    SET r.weight   = coalesce($weight, r.weight),
        r.note     = coalesce($note, r.note),
        r.ingestId = coalesce($ingestId, r.ingestId)
    `,
    {
      fromId,
      toId,
      weight: props.weight ?? null,
      note: props.note ?? null,
      ingestId: props.ingestId ?? null,
    },
  );
}

/** Record that a review session walked this edge. */
export async function reinforceEdge(
  fromId: string,
  toId: string,
  type: RelType,
): Promise<void> {
  if (!isRelType(type)) throw new Error(`Unknown relationship type "${type}"`);
  await write(
    `
    MATCH (a:Concept {id: $fromId})-[r:${type}]-(b:Concept {id: $toId})
    SET r.traversals   = coalesce(r.traversals, 0) + 1,
        r.reinforcedAt = datetime()
    `,
    { fromId, toId },
  );
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * `ALIVE` is the soft-delete predicate, written once and reused by every read.
 *
 * Deleting is a tombstone, not a removal: the node and its edges survive so an
 * accidental or injected delete is recoverable and undeleting restores the
 * connections too. The cost is that EVERY read path has to exclude them, and a
 * single forgotten predicate silently resurrects deleted concepts into search.
 * Hence one constant, and a check asserting a deleted concept is absent from
 * all six read paths.
 */
const ALIVE = "c.deletedAt IS NULL";

export async function getConcept(
  idOrName: string,
  { includeDeleted = false }: { includeDeleted?: boolean } = {},
): Promise<Concept | null> {
  const result = await read(
    `
    MATCH (c:Concept)
    WHERE (c.id = $key OR c.nameLower = $keyLower OR $key IN c.aliases
           OR $keyLower IN [a IN coalesce(c.aliases, []) | toLower(a)])
      AND (${includeDeleted ? "true" : ALIVE})
    OPTIONAL MATCH (c)-[:PART_OF]->(t:Topic)
    RETURN c AS concept, collect(DISTINCT t.name) AS topics
    LIMIT 1
    `,
    { key: idOrName, keyLower: idOrName.toLocaleLowerCase() },
  );
  const rec = result.records[0];
  if (!rec) return null;
  const node = rec.get("concept") as { properties: ConceptProps };
  return toConcept(node.properties, rec.get("topics") as string[]);
}

export interface Neighbourhood {
  center: Concept;
  nodes: Concept[];
  edges: Edge[];
  truncated: boolean;
}

/**
 * The induced subgraph within `depth` hops of a concept.
 *
 * Deliberately two queries — collect the node set, then the edges among it.
 * One query with variable-length paths is both harder to read and harder to
 * bound, and bounding is the point: a hub concept with 300 edges has to
 * degrade visibly rather than hang the explorer or blow past claude.ai's
 * ~150k-character tool-result ceiling.
 */
export async function getNeighbourhood(
  id: string,
  depth = 1,
  limit = 100,
): Promise<Neighbourhood | null> {
  const center = await getConcept(id);
  if (!center) return null;

  // Depth cannot be a Cypher parameter either, so clamp it to a small integer
  // before it reaches the string.
  const d = Math.max(1, Math.min(3, Math.trunc(depth) || 1));
  const cap = Math.max(1, Math.min(500, Math.trunc(limit) || 100));

  const nodeResult = await read(
    `
    MATCH (c:Concept {id: $id})
    MATCH (c)-[*1..${d}]-(m:Concept)
    WHERE m.id <> $id AND m.deletedAt IS NULL
    WITH DISTINCT m
    OPTIONAL MATCH (m)-[:PART_OF]->(t:Topic)
    RETURN m AS concept, collect(DISTINCT t.name) AS topics
    LIMIT $cap
    `,
    { id: center.id, cap: int(cap) },
  );

  const nodes = nodeResult.records.map((r) =>
    toConcept(
      (r.get("concept") as { properties: ConceptProps }).properties,
      r.get("topics") as string[],
    ),
  );
  const truncated = nodes.length >= cap;

  const ids = [center.id, ...nodes.map((n) => n.id)];
  const edgeResult = await read(
    `
    MATCH (a:Concept)-[r]->(b:Concept)
    WHERE a.id IN $ids AND b.id IN $ids
      AND a.deletedAt IS NULL AND b.deletedAt IS NULL
    RETURN a.id AS from, b.id AS to, type(r) AS type,
           coalesce(r.traversals, 0) AS traversals,
           r.reinforcedAt AS reinforcedAt
    `,
    { ids },
  );

  const edges: Edge[] = edgeResult.records.map((r) => ({
    from: String(r.get("from")),
    to: String(r.get("to")),
    type: String(r.get("type")) as RelType,
    traversals: num(r.get("traversals")),
    reinforcedAt: str(r.get("reinforcedAt")),
  }));

  return { center, nodes, edges, truncated };
}

/**
 * Lucene reserved characters.
 *
 * `db.index.fulltext.queryNodes` parses its argument as a Lucene query, so an
 * entirely ordinary question — "what is Foo::Bar?", "big-O (amortised)" —
 * throws a parse error and takes the whole search down with it. This is the
 * most likely runtime failure in this module precisely because the trigger
 * looks so innocuous.
 */
function escapeLucene(query: string): string {
  return query.replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, "\\$&").trim();
}

interface Ranked {
  id: string;
  name: string;
  body: string;
}

/**
 * Hybrid search: full-text and vector, fused by weighted reciprocal rank.
 *
 * Full-text wins on exact jargon you remember; vectors win on "that thing
 * about backpressure" where you remember the idea and not the word. Running
 * one without the other visibly fails half the time.
 */
export async function hybridSearch(
  query: string,
  limit = 10,
  opts: { weights?: { fulltext: number; vector: number }; rrfK?: number } = {},
): Promise<ScoredConcept[]> {
  const finalK = Math.max(1, Math.min(100, Math.trunc(limit) || 10));
  // Each source contributes 4x the final count: fusing two top-10 lists into a
  // top-10 mostly just returns whichever source ranked first, which defeats
  // the point of fusing at all.
  const sourceK = finalK * 4;
  const rrfK = opts.rrfK ?? 60;
  const weights = opts.weights ?? { fulltext: 1, vector: 1 };

  const escaped = escapeLucene(query);

  const fulltext = escaped
    ? read(
        `
        CALL db.index.fulltext.queryNodes('concept_text', $q) YIELD node, score
        WHERE node.deletedAt IS NULL
        RETURN node.id AS id, node.name AS name, node.body AS body
        LIMIT $k
        `,
        { q: escaped, k: int(sourceK) },
      )
    : Promise.resolve(null);

  const vector = embed(query).then((vec) =>
    read(
      `
      CALL db.index.vector.queryNodes('concept_vec', $k, $vec) YIELD node, score
      WHERE node.deletedAt IS NULL
      RETURN node.id AS id, node.name AS name, node.body AS body
      `,
      { k: int(sourceK), vec },
    ),
  );

  // One source failing must not take the other down with it — but it must not
  // be swallowed either, or search quality silently halves.
  const [ftResult, vecResult] = await Promise.allSettled([fulltext, vector]);

  const lists: Array<{ source: string; rows: Ranked[] }> = [];
  for (const [source, settled] of [
    ["fulltext", ftResult],
    ["vector", vecResult],
  ] as const) {
    if (settled.status === "rejected") {
      console.error(`[brain] hybridSearch: ${source} retriever failed —`, settled.reason);
      continue;
    }
    if (!settled.value) continue;
    lists.push({
      source,
      rows: settled.value.records.map((r) => ({
        id: String(r.get("id")),
        name: String(r.get("name")),
        body: (r.get("body") as string) ?? "",
      })),
    });
  }

  const fused = new Map<string, ScoredConcept>();
  for (const { source, rows } of lists) {
    const weight = source === "fulltext" ? weights.fulltext : weights.vector;
    rows.forEach((row, index) => {
      const entry = fused.get(row.id) ?? {
        id: row.id,
        name: row.name,
        body: row.body,
        score: 0,
        sources: [],
      };
      entry.score += weight / (rrfK + index + 1);
      entry.sources.push(source);
      fused.set(row.id, entry);
    });
  }

  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, finalK);
}

/**
 * Nearest concepts to a vector.
 *
 * Powers both halves of keeping the graph connected: the dedupe candidates
 * that make `remember` refuse an ambiguous write, and the link suggestions
 * that stop each conversation's concepts forming their own island.
 */
export async function findSimilar(
  vector: number[],
  opts: { excludeIds?: string[]; limit?: number; minScore?: number } = {},
): Promise<ScoredConcept[]> {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 10));
  const result = await read(
    `
    CALL db.index.vector.queryNodes('concept_vec', $k, $vec) YIELD node, score
    WHERE NOT node.id IN $exclude AND node.deletedAt IS NULL
    RETURN node.id AS id, node.name AS name, node.body AS body, score
    ORDER BY score DESC
    LIMIT $limit
    `,
    {
      // Over-fetch so the exclusions do not eat into the requested count.
      k: int(limit + (opts.excludeIds?.length ?? 0) + 5),
      vec: vector,
      exclude: opts.excludeIds ?? [],
      limit: int(limit),
    },
  );

  const minScore = opts.minScore ?? 0;
  return result.records
    .map((r) => ({
      id: String(r.get("id")),
      name: String(r.get("name")),
      body: (r.get("body") as string) ?? "",
      score: Number(r.get("score")),
      sources: ["vector"],
    }))
    .filter((c) => c.score >= minScore);
}

export interface GraphStats {
  concepts: number;
  topics: number;
  edges: number;
  /** Degree 0 or 1 — the stitching to-do list. */
  orphans: number;
  untracked: number;
  flagged: number;
  unembedded: number;
  /** Tombstoned, excluded from every other count here. */
  deleted: number;
}

export async function graphStats(): Promise<GraphStats> {
  // The sixth read path, and the easiest one to forget: without the
  // deletedAt filters every number here drifts upward over time and the
  // orphan count in particular becomes meaningless.
  const result = await read(`
    MATCH (c:Concept) WHERE c.deletedAt IS NULL
    WITH count(c) AS concepts,
         count(CASE WHEN NOT coalesce(c.tracked, false) THEN 1 END) AS untracked,
         count(CASE WHEN coalesce(c.flagged, false)     THEN 1 END) AS flagged,
         count(CASE WHEN c.embedding IS NULL            THEN 1 END) AS unembedded
    CALL () {
      MATCH (o:Concept) WHERE o.deletedAt IS NULL
        AND count{ (o)-[]-(n:Concept) WHERE n.deletedAt IS NULL } <= 1
      RETURN count(o) AS orphans
    }
    CALL () {
      MATCH (a:Concept)-[r]->(b:Concept)
      WHERE a.deletedAt IS NULL AND b.deletedAt IS NULL
      RETURN count(r) AS edges
    }
    CALL () {
      MATCH (t:Topic)
      RETURN count(t) AS topics
    }
    CALL () {
      MATCH (d:Concept) WHERE d.deletedAt IS NOT NULL
      RETURN count(d) AS deleted
    }
    RETURN concepts, untracked, flagged, unembedded, orphans, edges, topics, deleted
  `);

  const r = result.records[0];
  return {
    concepts: num(r.get("concepts")),
    topics: num(r.get("topics")),
    edges: num(r.get("edges")),
    orphans: num(r.get("orphans")),
    untracked: num(r.get("untracked")),
    flagged: num(r.get("flagged")),
    unembedded: num(r.get("unembedded")),
    deleted: num(r.get("deleted")),
  };
}

/**
 * Tombstone a concept. Reversible, and the edges survive.
 *
 * Deliberately single-id with no delete-by-query counterpart: this is the most
 * dangerous thing an injected instruction in a concept body could reach, so
 * the blast radius of one successful injection is capped at one concept per
 * tool call, each visible in the transcript.
 */
export async function softDeleteConcept(
  id: string,
): Promise<{ deleted: boolean; name?: string }> {
  const result = await write(
    `
    MATCH (c:Concept {id: $id})
    WHERE c.deletedAt IS NULL
    SET c.deletedAt = datetime()
    RETURN c.name AS name
    `,
    { id },
  );
  const rec = result.records[0];
  return rec ? { deleted: true, name: String(rec.get("name")) } : { deleted: false };
}

/** Undo a tombstone. Edges were never removed, so they come back with it. */
export async function restoreConcept(
  id: string,
): Promise<{ restored: boolean; name?: string }> {
  const result = await write(
    `
    MATCH (c:Concept {id: $id})
    WHERE c.deletedAt IS NOT NULL
    REMOVE c.deletedAt
    RETURN c.name AS name
    `,
    { id },
  );
  const rec = result.records[0];
  return rec ? { restored: true, name: String(rec.get("name")) } : { restored: false };
}

/** Previous bodies, newest first. Written by upsertConcept on every change. */
export async function getRevisions(
  id: string,
): Promise<Array<{ at: string; body: string }>> {
  const result = await read(
    "MATCH (c:Concept {id: $id}) RETURN coalesce(c.revisions, []) AS revisions",
    { id },
  );
  const raw = (result.records[0]?.get("revisions") as string[] | undefined) ?? [];
  return raw.flatMap((entry) => {
    try {
      return [JSON.parse(entry) as { at: string; body: string }];
    } catch {
      return [];
    }
  });
}

// ── The explorer ─────────────────────────────────────────────────────────────

export interface TopicSummary {
  name: string;
  concepts: number;
  tracked: number;
}

/**
 * Topics with their sizes, plus the concepts that belong to none.
 *
 * This is the explorer's way in. A search box is useless when you do not yet
 * know what you are looking for, which is most of the time with a knowledge
 * base you have been feeding for months.
 */
export async function topicOverview(): Promise<{
  topics: TopicSummary[];
  untopiced: number;
}> {
  const result = await read(`
    MATCH (t:Topic)<-[:PART_OF]-(c:Concept)
    WHERE ${ALIVE}
    RETURN t.name AS name,
           count(c) AS concepts,
           count(CASE WHEN c.tracked = true THEN 1 END) AS tracked
    ORDER BY concepts DESC, name ASC
  `);

  const loose = await read(`
    MATCH (c:Concept)
    WHERE ${ALIVE} AND NOT (c)-[:PART_OF]->(:Topic)
    RETURN count(c) AS n
  `);

  return {
    topics: result.records.map((r) => ({
      name: String(r.get("name")),
      concepts: num(r.get("concepts")),
      tracked: num(r.get("tracked")),
    })),
    untopiced: num(loose.records[0]?.get("n")),
  };
}

/** Live concepts in a topic, most recently updated first. */
export async function conceptsInTopic(topic: string, limit = 100): Promise<Concept[]> {
  const result = await read(
    `
    MATCH (c:Concept)-[:PART_OF]->(t:Topic {name: $topic})
    WHERE ${ALIVE}
    OPTIONAL MATCH (c)-[:PART_OF]->(all:Topic)
    RETURN c AS concept, collect(DISTINCT all.name) AS topics
    ORDER BY c.updatedAt DESC
    LIMIT $limit
    `,
    { topic, limit: int(Math.max(1, Math.min(500, limit))) },
  );
  return result.records.map((r) =>
    toConcept((r.get("concept") as { properties: Record<string, unknown> }).properties,
      r.get("topics") as string[]),
  );
}

/** Most recently updated live concepts, for the overview. */
export async function recentConcepts(limit = 12): Promise<Concept[]> {
  const result = await read(
    `
    MATCH (c:Concept)
    WHERE ${ALIVE}
    OPTIONAL MATCH (c)-[:PART_OF]->(t:Topic)
    RETURN c AS concept, collect(DISTINCT t.name) AS topics
    ORDER BY c.updatedAt DESC
    LIMIT $limit
    `,
    { limit: int(Math.max(1, Math.min(100, limit))) },
  );
  return result.records.map((r) =>
    toConcept((r.get("concept") as { properties: Record<string, unknown> }).properties,
      r.get("topics") as string[]),
  );
}

export interface DeletedConcept {
  id: string;
  name: string;
  deletedAt: string;
  edges: number;
}

/** Tombstoned concepts. The one view that deliberately looks past `ALIVE`. */
export async function listDeleted(limit = 100): Promise<DeletedConcept[]> {
  const result = await read(
    `
    MATCH (c:Concept)
    WHERE c.deletedAt IS NOT NULL
    RETURN c.id AS id, c.name AS name, toString(c.deletedAt) AS deletedAt,
           count{ (c)-[]-(:Concept) } AS edges
    ORDER BY c.deletedAt DESC
    LIMIT $limit
    `,
    { limit: int(Math.max(1, Math.min(500, limit))) },
  );
  return result.records.map((r) => ({
    id: String(r.get("id")),
    name: String(r.get("name")),
    deletedAt: String(r.get("deletedAt")),
    edges: num(r.get("edges")),
  }));
}

export interface DeletionImpact {
  id: string;
  name: string;
  /** Live concepts that lose a link if this is destroyed. */
  severs: Array<{ id: string; name: string; type: RelType }>;
}

/**
 * What a hard delete would break.
 *
 * Shown before the fact, because the edges are the part people forget: the
 * note is one paragraph they could rewrite, while the connections to it are
 * the thinking they cannot.
 */
export async function deletionImpact(id: string): Promise<DeletionImpact | null> {
  const result = await read(
    `
    MATCH (c:Concept {id: $id})
    OPTIONAL MATCH (c)-[r]-(other:Concept)
    WHERE other.deletedAt IS NULL
    RETURN c.name AS name,
           collect(DISTINCT {id: other.id, name: other.name, type: type(r)}) AS severs
    `,
    { id },
  );
  const rec = result.records[0];
  if (!rec) return null;

  const severs = (rec.get("severs") as Array<{ id: string; name: string; type: string }>)
    .filter((s) => s && s.id)
    .map((s) => ({ id: s.id, name: s.name, type: s.type as RelType }));

  return { id, name: String(rec.get("name")), severs };
}

/**
 * Destroy a concept and its edges. The only irreversible operation in the
 * system, and the only one not reachable over MCP.
 *
 * Two guards, both enforced here rather than in the UI, because a guard that
 * lives only in a form is a guard that a stray fetch does not have to pass:
 *
 *  - the concept must already be tombstoned, so destroying something is
 *    always two deliberate steps taken at two different moments;
 *  - `confirmName` must match the stored name exactly, so the caller has to
 *    have read what they are about to destroy.
 */
export async function hardDeleteConcept(
  id: string,
  confirmName: string,
): Promise<{ deleted: boolean; reason?: string; name?: string }> {
  const existing = await read(
    "MATCH (c:Concept {id: $id}) RETURN c.name AS name, c.deletedAt IS NOT NULL AS tombstoned",
    { id },
  );
  const rec = existing.records[0];
  if (!rec) return { deleted: false, reason: "No concept with that id." };

  const name = String(rec.get("name"));
  if (!rec.get("tombstoned")) {
    return {
      deleted: false,
      reason: "Delete it first. Permanent removal only applies to something already in the trash.",
    };
  }
  if (confirmName.trim() !== name) {
    return { deleted: false, reason: "The typed name does not match." };
  }

  await write("MATCH (c:Concept {id: $id}) DETACH DELETE c", { id });
  return { deleted: true, name };
}

/**
 * Remove one relationship. UI-only, like hard delete.
 *
 * Edges carry reinforcement counts that accumulate as you walk the graph, so
 * removing one does lose something — but a wrong link is worse than no link,
 * and the alternative is a graph you stop trusting.
 */
export async function unlinkConcepts(
  fromId: string,
  toId: string,
  type: RelType,
): Promise<{ removed: boolean }> {
  if (!isRelType(type)) {
    throw new Error(`Unknown relationship type "${type}".`);
  }
  const result = await write(
    `
    MATCH (a:Concept {id: $fromId})-[r:${type}]-(b:Concept {id: $toId})
    DELETE r
    RETURN count(r) AS n
    `,
    { fromId, toId },
  );
  return { removed: num(result.records[0]?.get("n")) > 0 };
}

/**
 * Concepts semantically near this one that it is NOT already linked to.
 *
 * Shared by the `suggest_links` tool and the explorer, so both answer the
 * question the same way. Each conversation is blind to the others, so without
 * deliberate stitching the graph becomes a pile of per-conversation islands —
 * folders with extra steps.
 */
export async function unlinkedNeighbours(
  conceptId: string,
  limit = 8,
): Promise<ScoredConcept[]> {
  const row = await read("MATCH (c:Concept {id: $id}) RETURN c.embedding AS vec", {
    id: conceptId,
  });
  const vec = row.records[0]?.get("vec") as number[] | null;
  if (!vec) return [];

  const linked = await read(
    "MATCH (c:Concept {id: $id})-[]-(o:Concept) RETURN collect(DISTINCT o.id) AS ids",
    { id: conceptId },
  );
  const exclude = [conceptId, ...((linked.records[0]?.get("ids") as string[]) ?? [])];
  return findSimilar(vec, { excludeIds: exclude, limit, minScore: 0.5 });
}
