import { randomUUID } from "node:crypto";
import { read, write, int } from "@/lib/neo4j";
import { cluster, describeClusters } from "@/lib/clusters";
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

  // Every node ON the path has to be a live Concept, not just the far end.
  //
  // PART_OF is overloaded: it is both a concept-to-concept relation in
  // REL_TYPES and the concept-to-topic edge. Without this predicate a depth-2
  // path can go Concept -> Topic -> Concept, so every concept sharing a topic
  // looks like a 2-hop neighbour. On the busiest concept here that was 135
  // "neighbours" where there are 102, and since the node set is capped at
  // 100 the extras were pushing out real links. Filtering on the
  // relationship type would be the wrong fix: concept-to-concept PART_OF is
  // legitimate and has to keep working.
  const nodeResult = await read(
    `
    MATCH p = (c:Concept {id: $id})-[*1..${d}]-(m:Concept)
    WHERE m.id <> $id
      AND all(n IN nodes(p) WHERE n:Concept AND n.deletedAt IS NULL)
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

/** How a note hangs off the one before it, so the reader is never dropped in. */
export interface ReadingVia {
  id: string;
  name: string;
  type: RelType;
  /** True when the relationship points INTO this note, from the other one. */
  incoming: boolean;
}

export interface ReadingItem {
  concept: Concept;
  /**
   * Links from the centre. Null only in a cluster read, for a member that no
   * link inside the cluster reaches.
   */
  hop: number | null;
  via: ReadingVia | null;
}

export interface NeighbourhoodNotes {
  center: Concept;
  items: ReadingItem[];
  /** True when the cap, not the graph, is why the walk stopped. */
  truncated: boolean;
}

/**
 * Enough notes to learn a subject from, few enough to actually finish.
 *
 * Lives here rather than in the page because the concept page has to promise
 * the same number on the way in ("read all 14 notes") that the reading page
 * delivers. Two copies of 40 is a lie waiting to happen.
 */
export const READING_CAP = 40;

/**
 * The notes around a note, in reading order.
 *
 * `getNeighbourhood` answers what the picture should look like; this answers
 * what to read, which is a different question. It carries the bodies, it
 * knows how far out each note is, and it says what connects each one to the
 * note before it.
 *
 * Done as ONE QUERY PER HOP over the frontier rather than a variable-length
 * match or shortestPath. Longer, and worth it three times over: the hop
 * number is exact rather than inferred from a path length, each round is
 * bounded by what is left of the cap instead of hoping a global LIMIT lands
 * somewhere sensible, and the `(m:Concept)` label on the far end makes the
 * Concept -> Topic -> Concept leak impossible by construction rather than by
 * a predicate someone has to remember.
 */
export async function neighbourhoodNotes(
  id: string,
  depth = 1,
  limit = READING_CAP,
): Promise<NeighbourhoodNotes | null> {
  const center = await getConcept(id);
  if (!center) return null;

  const d = Math.max(1, Math.min(3, Math.trunc(depth) || 1));
  const cap = Math.max(1, Math.min(200, Math.trunc(limit) || 40));

  const items: ReadingItem[] = [];
  const seen = new Set<string>([center.id]);
  let frontier = [center.id];
  let truncated = false;

  for (let hop = 1; hop <= d && frontier.length > 0; hop++) {
    const remaining = cap - items.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    // One over the cap, so overflow is detected without a counting query.
    const result = await read(
      `
      MATCH (a:Concept)-[r]-(m:Concept)
      WHERE a.id IN $frontier AND NOT m.id IN $seen
        AND a.deletedAt IS NULL AND m.deletedAt IS NULL
        AND type(r) IN $types
      WITH m, a, r
      ORDER BY a.name ASC, type(r) ASC
      WITH m, collect({
        id: a.id, name: a.name, type: type(r),
        incoming: endNode(r).id = m.id
      })[0] AS via
      WITH m, via, count{ (m)-[]-(x:Concept) WHERE x.deletedAt IS NULL } AS degree
      ORDER BY degree DESC, m.name ASC
      LIMIT $take
      OPTIONAL MATCH (m)-[:PART_OF]->(t:Topic)
      RETURN m AS concept, via, collect(DISTINCT t.name) AS topics
      `,
      {
        frontier,
        seen: [...seen],
        types: [...REL_TYPES],
        take: int(remaining + 1),
      },
    );

    const records = result.records;
    // The cap bit. Which notes survive it was decided by degree above, so
    // what you lose is the periphery rather than an arbitrary slice.
    const kept = records.length > remaining ? records.slice(0, remaining) : records;
    if (records.length > remaining) truncated = true;

    const next: string[] = [];
    for (const record of kept) {
      const concept = toConcept(
        (record.get("concept") as { properties: ConceptProps }).properties,
        record.get("topics") as string[],
      );
      const raw = record.get("via") as
        | { id: unknown; name: unknown; type: unknown; incoming: unknown }
        | null;

      items.push({
        concept,
        hop,
        via: raw
          ? {
              id: String(raw.id),
              name: String(raw.name),
              type: String(raw.type) as RelType,
              incoming: Boolean(raw.incoming),
            }
          : null,
      });
      seen.add(concept.id);
      next.push(concept.id);
    }

    if (truncated) break;
    frontier = next;
  }

  // Reading order, which is not the order the cap was decided in: by hop,
  // then grouped under the note each one hangs off, so related notes arrive
  // together instead of interleaved by popularity.
  items.sort(
    (a, b) =>
      (a.hop ?? 0) - (b.hop ?? 0) ||
      (a.via?.name ?? "").localeCompare(b.via?.name ?? "") ||
      a.concept.name.localeCompare(b.concept.name),
  );

  return { center, items, truncated };
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

/* ── The maintenance surfaces ──────────────────────────────────────────────
 *
 * These four queries used to live inside `inspect` in tools.ts, reachable
 * only over MCP. The explorer needs the same five answers, and a second copy
 * of each query is how the UI and Claude start quietly disagreeing about what
 * "orphan" means. Lifted here and called from both, the way
 * `unlinkedNeighbours` is already shared by the suggest-links tool and the
 * concept page.
 */

export interface InboxItem {
  id: string;
  text: string;
  at: string;
}

/** Captures waiting to be turned into concepts, oldest first. */
export async function listInbox(limit = 50): Promise<InboxItem[]> {
  const result = await read(
    `
    MATCH (b:Inbox) WHERE coalesce(b.processed, false) = false
    RETURN b.id AS id, b.text AS text, b.at AS at
    ORDER BY b.at ASC LIMIT $limit
    `,
    { limit: int(Math.max(1, Math.min(500, limit))) },
  );
  return result.records.map((r) => ({
    id: String(r.get("id")),
    text: String(r.get("text")),
    at: String(r.get("at")),
  }));
}

export interface FlaggedConcept {
  id: string;
  name: string;
  note: string | null;
  body: string;
}

/** Concepts marked wrong or unclear, most recently touched first. */
export async function listFlagged(limit = 50): Promise<FlaggedConcept[]> {
  const result = await read(
    `
    MATCH (c:Concept) WHERE ${ALIVE} AND c.flagged = true
    RETURN c.id AS id, c.name AS name, c.flagNote AS note, c.body AS body
    ORDER BY c.updatedAt DESC LIMIT $limit
    `,
    { limit: int(Math.max(1, Math.min(500, limit))) },
  );
  return result.records.map((r) => ({
    id: String(r.get("id")),
    name: String(r.get("name")),
    note: (r.get("note") as string) ?? null,
    body: (r.get("body") as string) ?? "",
  }));
}

export interface OrphanConcept {
  id: string;
  name: string;
  createdAt: string;
  links: number;
}

/**
 * Concepts with one link or none, oldest first.
 *
 * "One or none" rather than "none" on purpose: a concept joined to exactly
 * one other is almost always the tail of a single conversation that never
 * got stitched into anything, which is the same problem.
 */
export async function listOrphans(limit = 50): Promise<OrphanConcept[]> {
  const result = await read(
    `
    MATCH (c:Concept) WHERE ${ALIVE}
      AND count{ (c)-[]-(n:Concept) WHERE n.deletedAt IS NULL } <= 1
    RETURN c.id AS id, c.name AS name, c.createdAt AS createdAt,
           count{ (c)-[]-(n:Concept) WHERE n.deletedAt IS NULL } AS links
    ORDER BY c.createdAt ASC LIMIT $limit
    `,
    { limit: int(Math.max(1, Math.min(500, limit))) },
  );
  return result.records.map((r) => ({
    id: String(r.get("id")),
    name: String(r.get("name")),
    createdAt: String(r.get("createdAt")),
    links: num(r.get("links")),
  }));
}

export interface StaleConcept {
  id: string;
  name: string;
  lastReview: string | null;
}

/** Tracked concepts, least recently reviewed first. */
export async function listStale(limit = 25): Promise<StaleConcept[]> {
  const result = await read(
    `
    MATCH (c:Concept) WHERE ${ALIVE} AND c.tracked = true
    RETURN c.id AS id, c.name AS name, c.lastReview AS lastReview
    ORDER BY coalesce(c.lastReview, datetime('1970-01-01T00:00:00Z')) ASC
    LIMIT $limit
    `,
    { limit: int(Math.max(1, Math.min(500, limit))) },
  );
  return result.records.map((r) => ({
    id: String(r.get("id")),
    name: String(r.get("name")),
    lastReview: r.get("lastReview") ? String(r.get("lastReview")) : null,
  }));
}

/** Live concepts with no topic. They are invisible from the overview. */
export async function listUntopiced(limit = 50): Promise<Concept[]> {
  const result = await read(
    `
    MATCH (c:Concept)
    WHERE ${ALIVE} AND NOT (c)-[:PART_OF]->(:Topic)
    RETURN c AS concept
    ORDER BY c.updatedAt DESC LIMIT $limit
    `,
    { limit: int(Math.max(1, Math.min(500, limit))) },
  );
  return result.records.map((r) =>
    toConcept((r.get("concept") as { properties: Record<string, unknown> }).properties, []),
  );
}

/**
 * Set the flags that are not part of the body upsert.
 *
 * `tracked`, `flagged` and `flagNote` are plain properties with no revision
 * history and no embedding consequences, so they do not belong in
 * `upsertConcept`, which identifies by name and keeps revisions. Keyed on id
 * because every caller already has one.
 */
export async function setConceptFlags(
  id: string,
  flags: { tracked?: boolean; flagged?: boolean; flagNote?: string | null },
): Promise<boolean> {
  const patch: Record<string, unknown> = {};
  if (flags.tracked !== undefined) patch.tracked = flags.tracked;
  if (flags.flagged !== undefined) patch.flagged = flags.flagged;
  if (flags.flagNote !== undefined) patch.flagNote = flags.flagNote;
  if (Object.keys(patch).length === 0) return true;

  const result = await write(
    `
    MATCH (c:Concept {id: $id})
    SET c += $patch, c.updatedAt = datetime()
    RETURN count(c) AS n
    `,
    { id, patch },
  );
  return num(result.records[0]?.get("n")) > 0;
}

/**
 * Enrol a concept in spaced repetition, or take it out again.
 *
 * Separate from `setConceptFlags`, which is scoped to flags, for two reasons.
 *
 * It can carry the review prompt, which is safe to write here and nowhere
 * else cheap: `embeddingText` hashes name, aliases and body, so a prompt
 * cannot invalidate an embedding, and `revisions` only ever records a
 * superseded body. Enrolling a note is not editing it and must not leave a
 * revision behind, which is exactly what going through `upsertConcept` —
 * the editor's Save — would do.
 *
 * And it refuses a tombstone. `setConceptFlags` matches on id alone and will
 * flag a soft-deleted concept quite happily; nothing downstream notices
 * because every read filters `ALIVE`, but putting a note you have thrown away
 * into the review queue is not a thing to allow quietly.
 *
 * `null` means no live concept has that id, so a caller can tell that apart
 * from a write that changed nothing.
 */
export async function setTracked(
  id: string,
  tracked: boolean,
  { prompt }: { prompt?: string | null } = {},
): Promise<{ tracked: boolean; prompt: string | null } | null> {
  const patch: Record<string, unknown> = { tracked };
  if (prompt !== undefined) patch.prompt = prompt;

  const result = await write(
    `
    MATCH (c:Concept {id: $id})
    WHERE ${ALIVE}
    SET c += $patch, c.updatedAt = datetime()
    RETURN c.tracked AS tracked, c.prompt AS prompt
    `,
    { id, patch },
  );

  const rec = result.records[0];
  if (!rec) return null;
  return { tracked: Boolean(rec.get("tracked")), prompt: str(rec.get("prompt")) };
}

export interface FullGraphNode {
  id: string;
  name: string;
  /** Every topic this concept carries, sorted. */
  topics: string[];
  degree: number;
  tracked: boolean;
  flagged: boolean;
}

export interface GraphLink {
  from: string;
  to: string;
  type: RelType;
}

export interface FullGraph {
  nodes: FullGraphNode[];
  edges: GraphLink[];
  /** True when the cap, not the graph, is why you are seeing this much. */
  truncated: boolean;
  total: number;
}

/**
 * The whole graph, capped.
 *
 * Ordered by degree so that if the cap bites, what survives is the connected
 * core rather than an arbitrary slice. Showing the thousand least connected
 * concepts would be worse than showing nothing: it looks like a dust cloud
 * and says nothing true about the shape of the graph.
 *
 * The cap exists because Cytoscape degrades badly past a couple of thousand
 * nodes, and because the payload crosses the wire. `truncated` and `total`
 * are reported so the page can say so rather than silently lying about size,
 * the same contract `getNeighbourhood` already uses.
 */
export async function fullGraph(limit = 1500): Promise<FullGraph> {
  const capped = Math.max(1, Math.min(4000, limit));

  const totalResult = await read(`MATCH (c:Concept) WHERE ${ALIVE} RETURN count(c) AS n`);
  const total = num(totalResult.records[0]?.get("n"));

  const nodeResult = await read(
    `
    MATCH (c:Concept) WHERE ${ALIVE}
    WITH c, count{ (c)-[]-(n:Concept) WHERE n.deletedAt IS NULL } AS degree
    ORDER BY degree DESC, c.updatedAt DESC
    LIMIT $limit
    OPTIONAL MATCH (c)-[:PART_OF]->(t:Topic)
    RETURN c.id AS id, c.name AS name, degree,
           coalesce(c.tracked, false) AS tracked,
           coalesce(c.flagged, false) AS flagged,
           collect(t.name) AS topics
    `,
    { limit: int(capped) },
  );

  const nodes: FullGraphNode[] = nodeResult.records.map((r) => ({
    id: String(r.get("id")),
    name: String(r.get("name")),
    // All of them. This used to keep only the alphabetically first topic,
    // which was what the canvas coloured by: with two to four topics on
    // almost every concept, that amounted to colouring by alphabet. Colour
    // now comes from the link clusters, and the full list is what lets a
    // cluster be labelled with the topic that is over-represented in it.
    // Sorted here rather than in Cypher, which would need APOC.
    topics: [...((r.get("topics") as string[]) ?? [])].sort(),
    degree: num(r.get("degree")),
    tracked: Boolean(r.get("tracked")),
    flagged: Boolean(r.get("flagged")),
  }));

  // Edges only among the nodes that survived the cap. An edge pointing at a
  // node that was cut would be dropped by the renderer anyway.
  const ids = nodes.map((n) => n.id);
  const edgeResult =
    ids.length === 0
      ? null
      : await read(
          `
          MATCH (a:Concept)-[r]->(b:Concept)
          WHERE a.id IN $ids AND b.id IN $ids
            AND a.deletedAt IS NULL AND b.deletedAt IS NULL
            AND type(r) IN $types
          RETURN a.id AS from, b.id AS to, type(r) AS type
          `,
          { ids, types: [...REL_TYPES] },
        );

  const edges: GraphLink[] = (edgeResult?.records ?? []).map((r) => ({
    from: String(r.get("from")),
    to: String(r.get("to")),
    type: String(r.get("type")) as RelType,
  }));

  return { nodes, edges, truncated: total > nodes.length, total };
}

/* ── Ingest batches ────────────────────────────────────────────────────────
 *
 * `remember` has always returned a `reviewUrl` pointing at /ingest/<id>, and
 * that page did not exist, so the system handed out a dead link on its most
 * used path. Everything the page needs was already being written to the
 * :Ingest node; it just had no reader.
 */

export interface IngestSummary {
  id: string;
  at: string;
  summary: string;
  toolCaller: string | null;
  undone: boolean;
  undoneAt: string | null;
  created: number;
  merged: number;
  edges: number;
}

/** Every batch, newest first. */
export async function listIngests(limit = 50): Promise<IngestSummary[]> {
  const result = await read(
    `
    MATCH (i:Ingest)
    RETURN i.id AS id, i.at AS at, i.summary AS summary,
           i.toolCaller AS toolCaller,
           coalesce(i.undone, false) AS undone, i.undoneAt AS undoneAt,
           size(coalesce(i.createdIds, []))   AS created,
           size(coalesce(i.mergedIds, []))    AS merged,
           size(coalesce(i.createdEdges, [])) AS edges
    ORDER BY i.at DESC LIMIT $limit
    `,
    { limit: int(Math.max(1, Math.min(200, limit))) },
  );
  return result.records.map((r) => ({
    id: String(r.get("id")),
    at: String(r.get("at")),
    summary: (r.get("summary") as string) ?? "",
    toolCaller: (r.get("toolCaller") as string) ?? null,
    undone: Boolean(r.get("undone")),
    undoneAt: r.get("undoneAt") ? String(r.get("undoneAt")) : null,
    created: num(r.get("created")),
    merged: num(r.get("merged")),
    edges: num(r.get("edges")),
  }));
}

export interface BatchConcept {
  id: string;
  name: string;
  body: string;
  /** A concept an undo tombstoned still belongs on the page, marked. */
  deleted: boolean;
}

export interface BatchEdge {
  from: string;
  to: string;
  type: string;
  fromName: string;
  toName: string;
  /** False once an undo has removed it. */
  present: boolean;
}

export interface IngestBatch extends IngestSummary {
  createdConcepts: BatchConcept[];
  mergedConcepts: BatchConcept[];
  links: BatchEdge[];
}

/**
 * One batch, with the concepts and links resolved to names.
 *
 * Tombstoned concepts are deliberately included and marked rather than
 * filtered out. After an undo every concept the batch created is a tombstone,
 * and a page that hid them would show an empty batch, which looks like data
 * loss rather than a successful undo.
 */
export async function getIngestBatch(id: string): Promise<IngestBatch | null> {
  const found = await read(
    `
    MATCH (i:Ingest {id: $id})
    RETURN i.id AS id, i.at AS at, i.summary AS summary,
           i.toolCaller AS toolCaller,
           coalesce(i.undone, false) AS undone, i.undoneAt AS undoneAt,
           coalesce(i.createdIds, [])   AS createdIds,
           coalesce(i.mergedIds, [])    AS mergedIds,
           coalesce(i.createdEdges, []) AS createdEdges
    `,
    { id },
  );
  const rec = found.records[0];
  if (!rec) return null;

  const createdIds = (rec.get("createdIds") as string[]) ?? [];
  const mergedIds = (rec.get("mergedIds") as string[]) ?? [];
  const rawEdges = ((rec.get("createdEdges") as string[]) ?? []).flatMap((s) => {
    try {
      return [JSON.parse(s) as { from: string; to: string; type: string }];
    } catch {
      // A malformed record should cost one link, not the whole page.
      return [];
    }
  });

  const names = new Map<string, { name: string; body: string; deleted: boolean }>();
  const wanted = [...new Set([...createdIds, ...mergedIds, ...rawEdges.flatMap((e) => [e.from, e.to])])];
  if (wanted.length > 0) {
    const rows = await read(
      `
      UNWIND $ids AS id
      MATCH (c:Concept {id: id})
      RETURN c.id AS id, c.name AS name, c.body AS body,
             c.deletedAt IS NOT NULL AS deleted
      `,
      { ids: wanted },
    );
    for (const row of rows.records) {
      names.set(String(row.get("id")), {
        name: String(row.get("name")),
        body: (row.get("body") as string) ?? "",
        deleted: Boolean(row.get("deleted")),
      });
    }
  }

  // Which of the batch's links are still in the graph. An undo removes them
  // outright, and a later edit may have removed one by hand.
  const present = new Set<string>();
  if (rawEdges.length > 0) {
    const live = await read(
      `
      MATCH (a:Concept)-[r]->(b:Concept)
      WHERE r.ingestId = $id
      RETURN a.id AS from, b.id AS to, type(r) AS type
      `,
      { id },
    );
    for (const row of live.records) {
      present.add(`${row.get("from")}|${row.get("to")}|${row.get("type")}`);
    }
  }

  const resolve = (cid: string): BatchConcept => {
    const hit = names.get(cid);
    return {
      id: cid,
      // A hard delete from /trash can remove a concept a batch created, so
      // the id may no longer resolve to anything.
      name: hit?.name ?? "(destroyed)",
      body: hit?.body ?? "",
      deleted: hit?.deleted ?? true,
    };
  };

  return {
    id: String(rec.get("id")),
    at: String(rec.get("at")),
    summary: (rec.get("summary") as string) ?? "",
    toolCaller: (rec.get("toolCaller") as string) ?? null,
    undone: Boolean(rec.get("undone")),
    undoneAt: rec.get("undoneAt") ? String(rec.get("undoneAt")) : null,
    created: createdIds.length,
    merged: mergedIds.length,
    edges: rawEdges.length,
    createdConcepts: createdIds.map(resolve),
    mergedConcepts: mergedIds.map(resolve),
    links: rawEdges.map((e) => ({
      ...e,
      fromName: names.get(e.from)?.name ?? "(destroyed)",
      toName: names.get(e.to)?.name ?? "(destroyed)",
      present: present.has(`${e.from}|${e.to}|${e.type}`),
    })),
  };
}

/**
 * Rename a concept, keyed on its id.
 *
 * This has to exist separately because `upsertConcept` identifies a concept
 * by `nameLower` and nothing else. That is correct for ingest, where the name
 * IS the identity and two conversations naming the same thing must converge
 * on one node. It is wrong for an edit: calling it with a changed name
 * created a second concept and left the original untouched, so the edit
 * vanished and the graph quietly grew a duplicate.
 *
 * Case-only changes are handled too. `nameLower` does not move, but `name` is
 * the display form and MERGE only sets it ON CREATE, so "raft" to "Raft"
 * would otherwise be silently ignored.
 */
export async function renameConcept(
  id: string,
  newName: string,
): Promise<{ renamed: boolean; reason?: string }> {
  const name = newName.trim();
  if (!name) return { renamed: false, reason: "A concept needs a name." };
  const nameLower = name.toLocaleLowerCase();

  const current = await read(
    "MATCH (c:Concept {id: $id}) RETURN c.name AS name, c.nameLower AS lower",
    { id },
  );
  const row = current.records[0];
  if (!row) return { renamed: false, reason: "No concept with that id." };
  if (String(row.get("name")) === name) return { renamed: true };

  // The uniqueness constraint on nameLower would reject this anyway, but as a
  // raw Neo4j error rather than something worth showing anyone.
  if (String(row.get("lower")) !== nameLower) {
    const clash = await read(
      "MATCH (c:Concept {nameLower: $nameLower}) RETURN c.id AS id",
      { nameLower },
    );
    const other = clash.records[0];
    if (other && String(other.get("id")) !== id) {
      return {
        renamed: false,
        reason: `"${name}" already exists. Names are the identity here, so two concepts cannot share one.`,
      };
    }
  }

  await write(
    `MATCH (c:Concept {id: $id})
     SET c.name = $name, c.nameLower = $nameLower, c.updatedAt = datetime()`,
    { id, name, nameLower },
  );
  return { renamed: true };
}

export interface NavCounts {
  inbox: number;
  due: number;
  orphans: number;
  flagged: number;
  trash: number;
}

/**
 * The five numbers in the nav.
 *
 * One round trip, because this runs on every page render. The counts are the
 * whole point of putting them there: an inbox you cannot see is an inbox you
 * do not clear, and the same goes for orphans, which accumulate silently
 * because each conversation is blind to the others.
 *
 * `due` repeats the predicate from `dueForReview` rather than calling it:
 * that function also reads today's counts and applies the daily caps, which
 * is three more queries for a number in a nav. The badge means "due", not
 * "left in today's allowance" — tell the user the truth about their backlog
 * and let /review explain the caps.
 */
export async function navCounts(): Promise<NavCounts> {
  const result = await read(`
    CALL () {
      MATCH (b:Inbox) WHERE coalesce(b.processed, false) = false
      RETURN count(b) AS inbox
    }
    CALL () {
      MATCH (c:Concept)
      WHERE ${ALIVE} AND c.tracked = true AND (c.due IS NULL OR c.due <= datetime())
      RETURN count(c) AS due
    }
    CALL () {
      MATCH (c:Concept)
      WHERE ${ALIVE} AND count{ (c)-[]-(n:Concept) WHERE n.deletedAt IS NULL } <= 1
      RETURN count(c) AS orphans
    }
    CALL () {
      MATCH (c:Concept) WHERE ${ALIVE} AND c.flagged = true
      RETURN count(c) AS flagged
    }
    CALL () {
      MATCH (c:Concept) WHERE c.deletedAt IS NOT NULL
      RETURN count(c) AS trash
    }
    RETURN inbox, due, orphans, flagged, trash
  `);

  const r = result.records[0];
  return {
    inbox: num(r?.get("inbox")),
    due: num(r?.get("due")),
    orphans: num(r?.get("orphans")),
    flagged: num(r?.get("flagged")),
    trash: num(r?.get("trash")),
  };
}

export interface ClusterNotes extends NeighbourhoodNotes {
  /** Members of the whole cluster, the centre included, before any cap. */
  size: number;
  /** How the legend names this cluster: its landmark, and its stand-out topic. */
  label: { name: string; topic: string | null };
}

/**
 * Every note in one link community, in an order you can read.
 *
 * The communities are not stored anywhere. They are found by `clusters.ts`
 * from the link structure, and the canvas finds them in the browser. Rather
 * than shipping a list of thirty ids through a URL so the server can be told
 * what the browser decided, this recomputes them: `cluster` is a pure
 * function of the graph and `fullGraph` is what the canvas was given, so the
 * same input produces the same grouping on both sides. The page and the
 * picture agree because they did the same arithmetic, not because one
 * trusted the other.
 *
 * Order is breadth-first from the note you asked about, following only links
 * that stay inside the community, so you start where you are and work out.
 * A member no intra-community link reaches gets `hop: null` and comes last;
 * modularity does not promise a connected community, only a dense one.
 */
export async function clusterNotes(
  id: string,
  limit = READING_CAP,
): Promise<ClusterNotes | null> {
  const center = await getConcept(id);
  if (!center) return null;

  const graph = await fullGraph();
  const clustering = cluster(graph.nodes, graph.edges);
  const index = clustering.of.get(center.id);
  // Not in the clustered slice: the graph was over the cap and this note was
  // outside it. There is no community to read, which the caller must handle.
  if (index === undefined) return null;

  const members = new Set(clustering.clusters[index]);
  const info = describeClusters(graph.nodes, clustering)[index];
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  // Adjacency inside the community only. `incoming` is relative to the note
  // being reached, not the one being expanded from — it answers "which way
  // does this point at me", which is what the relation line prints.
  const links = new Map<string, Array<{ to: string; via: ReadingVia }>>();
  const add = (from: string, to: string, type: RelType, incoming: boolean) => {
    const parent = nodeById.get(from);
    if (!parent) return;
    const list = links.get(from) ?? [];
    list.push({ to, via: { id: from, name: parent.name, type, incoming } });
    links.set(from, list);
  };
  for (const e of graph.edges) {
    if (!members.has(e.from) || !members.has(e.to)) continue;
    add(e.from, e.to, e.type, true);
    add(e.to, e.from, e.type, false);
  }

  // Busiest first at every step, then alphabetical: the same tie-break the
  // hop walk uses, so the two reading orders feel like one thing.
  const rank = (a: string, b: string) => {
    const na = nodeById.get(a);
    const nb = nodeById.get(b);
    return (nb?.degree ?? 0) - (na?.degree ?? 0) || (na?.name ?? "").localeCompare(nb?.name ?? "");
  };

  const order: Array<{ id: string; hop: number | null; via: ReadingVia | null }> = [];
  const seen = new Set<string>([center.id]);
  let frontier = [center.id];

  for (let hop = 1; frontier.length > 0; hop++) {
    const found = new Map<string, ReadingVia>();
    for (const from of [...frontier].sort(rank)) {
      for (const edge of links.get(from) ?? []) {
        if (seen.has(edge.to) || found.has(edge.to)) continue;
        found.set(edge.to, edge.via);
      }
    }
    const next = [...found.keys()].sort(rank);
    for (const nid of next) {
      seen.add(nid);
      order.push({ id: nid, hop, via: found.get(nid)! });
    }
    frontier = next;
  }

  for (const nid of [...members].filter((m) => !seen.has(m)).sort(rank)) {
    order.push({ id: nid, hop: null, via: null });
  }

  const cap = Math.max(1, Math.min(200, Math.trunc(limit) || READING_CAP));
  const kept = order.slice(0, cap);

  const bodies = await read(
    `
    MATCH (c:Concept) WHERE c.id IN $ids AND ${ALIVE}
    OPTIONAL MATCH (c)-[:PART_OF]->(t:Topic)
    RETURN c AS concept, collect(DISTINCT t.name) AS topics
    `,
    { ids: kept.map((k) => k.id) },
  );
  const conceptById = new Map(
    bodies.records.map((r) => {
      const concept = toConcept(
        (r.get("concept") as { properties: ConceptProps }).properties,
        r.get("topics") as string[],
      );
      return [concept.id, concept];
    }),
  );

  const items: ReadingItem[] = kept.flatMap((k) => {
    const concept = conceptById.get(k.id);
    return concept ? [{ concept, hop: k.hop, via: k.via }] : [];
  });

  return {
    center,
    items,
    truncated: order.length > kept.length,
    size: members.size,
    label: { name: info?.name ?? center.name, topic: info?.topic ?? null },
  };
}
