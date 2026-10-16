import { write, read } from "@/lib/neo4j";

/**
 * Schema setup. Every statement is `IF NOT EXISTS`, so this is safe to run on
 * every boot and is the only place the graph's shape is declared.
 *
 * The vector index dimension (384) is locked to the embedding model. Changing
 * models later invalidates every stored vector and requires dropping and
 * recreating this index — see scripts/reembed.mjs and the embeddingModel /
 * embeddingVersion properties carried on each Concept.
 */

export const EMBEDDING_DIMS = 384;

const STATEMENTS: string[] = [
  // Identity. The uniqueness constraint on `name` is deliberate: it forces
  // disambiguation ("Leader election (Raft)" vs "Leader election (Paxos)")
  // instead of silently accumulating near-duplicates, and it makes concurrent
  // MERGE from two Claude clients safe by taking a lock on the property.
  // `aliases` is the pressure valve for the same idea under another name.
  "CREATE CONSTRAINT concept_id IF NOT EXISTS FOR (c:Concept) REQUIRE c.id IS UNIQUE",
  "CREATE CONSTRAINT concept_name IF NOT EXISTS FOR (c:Concept) REQUIRE c.name IS UNIQUE",
  "CREATE CONSTRAINT topic_id IF NOT EXISTS FOR (t:Topic) REQUIRE t.id IS UNIQUE",
  "CREATE CONSTRAINT topic_name IF NOT EXISTS FOR (t:Topic) REQUIRE t.name IS UNIQUE",
  "CREATE CONSTRAINT source_id IF NOT EXISTS FOR (s:Source) REQUIRE s.id IS UNIQUE",
  "CREATE CONSTRAINT ingest_id IF NOT EXISTS FOR (i:Ingest) REQUIRE i.id IS UNIQUE",
  "CREATE CONSTRAINT inbox_id IF NOT EXISTS FOR (b:Inbox) REQUIRE b.id IS UNIQUE",

  // Review queue lookups: "what is due, among tracked concepts".
  "CREATE INDEX concept_due IF NOT EXISTS FOR (c:Concept) ON (c.due)",
  "CREATE INDEX concept_tracked IF NOT EXISTS FOR (c:Concept) ON (c.tracked)",
  "CREATE INDEX inbox_processed IF NOT EXISTS FOR (b:Inbox) ON (b.processed)",

  // Search. Full-text wins on exact jargon, the vector index wins on "that
  // thing about backpressure"; hybrid search runs both and fuses the ranks.
  "CREATE FULLTEXT INDEX concept_text IF NOT EXISTS FOR (c:Concept) ON EACH [c.name, c.body]",
  `CREATE VECTOR INDEX concept_vec IF NOT EXISTS FOR (c:Concept) ON c.embedding
     OPTIONS {indexConfig: {
       \`vector.dimensions\`: ${EMBEDDING_DIMS},
       \`vector.similarity_function\`: 'cosine'
     }}`,
];

export async function ensureSchema(): Promise<{ applied: number }> {
  for (const stmt of STATEMENTS) {
    await write(stmt);
  }
  return { applied: STATEMENTS.length };
}

/** Names of the constraints and indexes that currently exist, for health checks. */
export async function describeSchema(): Promise<{
  constraints: string[];
  indexes: string[];
}> {
  const c = await read("SHOW CONSTRAINTS YIELD name RETURN name ORDER BY name");
  const i = await read("SHOW INDEXES YIELD name RETURN name ORDER BY name");
  return {
    constraints: c.records.map((r) => r.get("name") as string),
    indexes: i.records.map((r) => r.get("name") as string),
  };
}
