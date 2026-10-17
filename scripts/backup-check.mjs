/**
 * Round-trip restore test: export → wipe → import → assert the graph is equal.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   npm run backup:check
 *
 * "An untested backup is not a backup." Rather than a one-off rehearsal that
 * would never be repeated, the rehearsal IS the test, and it runs against the
 * throwaway Neo4j on 7688 so it can safely delete everything it can reach.
 *
 * Exits 1 on any mismatch.
 */
import assert from "node:assert/strict";

const TEST_URI = process.env.NEO4J_URI ?? "bolt://localhost:7688";

// Allowlist, not denylist — this script's whole job involves DETACH DELETE.
// Inside the compose network the test server also listens on 7687, so only the
// hostname distinguishes it from production.
const ALLOWED = [
  /^bolt:\/\/(localhost|127\.0\.0\.1):7688$/,
  /^bolt:\/\/brain-neo4j-test:7687$/,
];
if (!ALLOWED.some((re) => re.test(TEST_URI))) {
  console.error(
    `REFUSING TO RUN: NEO4J_URI is ${TEST_URI}, which is not a recognised\n` +
      `throwaway target. This script deletes every node it can reach.`,
  );
  process.exit(1);
}

process.env.NEO4J_URI = TEST_URI;
process.env.NEO4J_USER = process.env.NEO4J_USER ?? "neo4j";
process.env.NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? "testpassword";
process.env.MODEL_DIR = process.env.MODEL_DIR ?? "./.models";
process.env.ALLOW_REMOTE_MODELS = process.env.ALLOW_REMOTE_MODELS ?? "1";

const { getDriver, read, write, waitForNeo4j } = await import("@/lib/neo4j");
const { ensureSchema } = await import("@/lib/schema");
const { exportGraph, toMarkdownFiles } = await import("@/lib/export");
const { restoreGraph } = await import("@/lib/restore");
const G = await import("@/lib/graph");

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err && err.message ? err.message : err}`);
  }
}
const section = (t) => console.log(`\n${t}`);

// ── Fixture ──────────────────────────────────────────────────────────────────

console.log(`backup-check against ${TEST_URI}`);
await waitForNeo4j({ attempts: 40, delayMs: 2000 });
await ensureSchema();
await write("MATCH (n) DETACH DELETE n");

/**
 * Covers every label, every relationship type, FSRS state on a tracked
 * concept, aliases, topics, and a body with newlines, unicode and markdown —
 * because the things that break a round trip are exactly the awkward values.
 */
async function buildFixture() {
  const raft = await G.upsertConcept({
    name: "Raft",
    aliases: ["Raft consensus", "RAFT"],
    body: "# Raft\n\nA consensus protocol.\n\n- elected leader\n- replicated log\n\nSee «Paxos» — naïve résumé 日本語 \"quotes\" and a \\ backslash.",
    topics: ["Distributed systems"],
    prompt: "How does Raft elect a leader?",
  });
  const paxos = await G.upsertConcept({ name: "Paxos", body: "Earlier consensus protocol." });
  const quorum = await G.upsertConcept({ name: "Quorum", body: "A majority." });
  const election = await G.upsertConcept({ name: "Leader election", body: "Picking one." });
  const clocks = await G.upsertConcept({ name: "Vector clocks", body: "Partial ordering." });

  await G.linkConcepts(quorum.id, raft.id, "PREREQUISITE_OF", { note: "need this first" });
  await G.linkConcepts(raft.id, paxos.id, "CONTRASTS_WITH");
  await G.linkConcepts(election.id, raft.id, "PART_OF");
  await G.linkConcepts(raft.id, clocks.id, "RELATED_TO", { weight: 0.75 });
  await G.linkConcepts(election.id, paxos.id, "EXAMPLE_OF");

  // FSRS state on a tracked concept — the thing a naive restore silently
  // resets, and the reason restore.ts does not go through upsertConcept.
  await write(
    `
    MATCH (c:Concept {id: $id})
    SET c.tracked    = true,
        c.state      = 'review',
        c.stability  = 12.5,
        c.difficulty = 4.25,
        c.reps       = 7,
        c.lapses     = 2,
        c.due        = datetime('2026-11-01T09:30:00Z'),
        c.lastReview = datetime('2026-10-14T09:30:00Z'),
        c.flagged    = true,
        c.flagNote   = 'check the election timeout numbers'
    `,
    { id: raft.id },
  );

  // Labels milestone 4 introduces. Created directly because their helpers do
  // not exist yet — the backup has to cover them from the day the schema does.
  await write(
    `
    CREATE (s:Source {id: 'src-1', kind: 'url', ref: 'https://raft.github.io/',
                      title: 'The Raft site', capturedAt: datetime('2026-10-01T12:00:00Z')})
    CREATE (i:Ingest {id: 'ing-1', at: datetime('2026-10-01T12:00:00Z'),
                      summary: '5 concepts from a conversation', toolCaller: 'claude.ai', undone: false})
    CREATE (b:Inbox  {id: 'inb-1', at: datetime('2026-10-02T08:00:00Z'),
                      text: 'look up CRDTs', processed: false})
    `,
  );
  await write(
    `MATCH (c:Concept {id: $id}), (s:Source {id: 'src-1'}) MERGE (c)-[:CITES]->(s)`,
    { id: raft.id },
  );

  return { raftId: raft.id };
}

const { raftId } = await buildFixture();
const original = await exportGraph();

// ── Export shape ─────────────────────────────────────────────────────────────

section("export");

await check("covers every label present in the graph", async () => {
  for (const label of ["Concept", "Topic", "Source", "Ingest", "Inbox"]) {
    assert.ok(original.nodes[label]?.length, `${label} missing from the export`);
  }
});

await check("covers every relationship type", async () => {
  const types = new Set(original.edges.map((e) => e.type));
  for (const t of G.REL_TYPES) {
    assert.ok(types.has(t), `${t} missing from the export`);
  }
});

await check("excludes embeddings by default", async () => {
  assert.equal(original.embeddingsIncluded, false);
  for (const c of original.nodes.Concept) {
    assert.equal(c.embedding, undefined, `${c.name} carried a vector into the export`);
  }
});

await check("includes embeddings when asked", async () => {
  const withVec = await exportGraph({ withEmbeddings: true });
  assert.equal(withVec.embeddingsIncluded, true);
  assert.equal(withVec.nodes.Concept[0].embedding.length, 384);
});

await check("serialises temporals as ISO strings, not driver objects", async () => {
  const raft = original.nodes.Concept.find((c) => c.id === raftId);
  assert.equal(typeof raft.due, "string", "due must be a string in JSON");
  assert.match(raft.due, /^2026-11-01T09:30/, `got ${raft.due}`);
  assert.equal(typeof raft.createdAt, "string");
});

await check("serialises integers as numbers, not {low, high}", async () => {
  const raft = original.nodes.Concept.find((c) => c.id === raftId);
  assert.equal(typeof raft.reps, "number");
  assert.equal(raft.reps, 7);
});

await check("survives a JSON round trip unchanged", async () => {
  const reparsed = JSON.parse(JSON.stringify(original));
  assert.deepEqual(reparsed, original, "export is not plain JSON-safe data");
});

await check("refuses to run when the graph has an unknown label", async () => {
  await write("CREATE (:Mystery {id: 'mystery-1'})");
  try {
    await assert.rejects(
      () => exportGraph(),
      /does not know how to write/,
      "an unrecognised label must fail the backup, not be silently skipped",
    );
  } finally {
    await write("MATCH (n:Mystery) DETACH DELETE n");
  }
});

await check("refuses to run when a node has multiple labels", async () => {
  await write("CREATE (:Concept:Topic {id: 'double-1', name: 'double'})");
  try {
    await assert.rejects(() => exportGraph(), /multiple labels/);
  } finally {
    await write("MATCH (n {id: 'double-1'}) DETACH DELETE n");
  }
});

// ── Round trip ───────────────────────────────────────────────────────────────

section("restore");

let restored;

await check("imports into an empty database", async () => {
  await write("MATCH (n) DETACH DELETE n");
  const before = await read("MATCH (n) RETURN count(n) AS n");
  assert.equal(before.records[0].get("n").toNumber(), 0, "wipe did not empty the graph");

  const result = await restoreGraph(original);
  assert.equal(result.skippedEdges, 0, "every edge found its endpoints");
  assert.ok(result.reEmbedded > 0, "concepts were re-embedded");
  restored = await exportGraph();
});

await check("the restored graph is identical to the original", async () => {
  // Compare the two exports wholesale. exportedAt necessarily differs; nothing
  // else may.
  const strip = (e) => ({ ...e, exportedAt: null });
  assert.deepEqual(strip(restored), strip(original));
});

await check("preserves ids", async () => {
  const raft = restored.nodes.Concept.find((c) => c.name === "Raft");
  assert.equal(raft.id, raftId, "a new id would break every edge reference");
});

await check("preserves FSRS review state", async () => {
  const raft = restored.nodes.Concept.find((c) => c.id === raftId);
  assert.equal(raft.tracked, true);
  assert.equal(raft.state, "review");
  assert.equal(raft.stability, 12.5);
  assert.equal(raft.difficulty, 4.25);
  assert.equal(raft.reps, 7);
  assert.equal(raft.lapses, 2);
  assert.match(raft.due, /^2026-11-01T09:30/);
  assert.match(raft.lastReview, /^2026-10-14T09:30/);
});

await check("restores temporals as datetimes, not strings", async () => {
  // The silent killer: a `due` restored as a string compares false against
  // every datetime in the review queue, so nothing is ever due again.
  const r = await read(
    "MATCH (c:Concept {id: $id}) RETURN c.due AS due, valueType(c.due) AS t",
    { id: raftId },
  );
  assert.match(String(r.records[0].get("t")), /ZONED DATETIME|DATETIME/i,
    `due came back as ${r.records[0].get("t")}`);
});

await check("preserves aliases, topics, prompt and flags", async () => {
  const raft = restored.nodes.Concept.find((c) => c.id === raftId);
  assert.deepEqual([...raft.aliases].sort(), ["RAFT", "Raft consensus"]);
  assert.equal(raft.prompt, "How does Raft elect a leader?");
  assert.equal(raft.flagged, true);
  assert.equal(raft.flagNote, "check the election timeout numbers");
  const c = await G.getConcept(raftId);
  assert.ok(c.topics.includes("Distributed systems"));
});

await check("preserves awkward body text exactly", async () => {
  const raft = restored.nodes.Concept.find((c) => c.id === raftId);
  const originalRaft = original.nodes.Concept.find((c) => c.id === raftId);
  assert.equal(raft.body, originalRaft.body, "unicode/newlines/quotes mangled");
  assert.ok(raft.body.includes("日本語"));
  assert.ok(raft.body.includes("\\ backslash"));
});

await check("preserves edge properties", async () => {
  const weighted = restored.edges.find((e) => e.type === "RELATED_TO");
  assert.equal(weighted.props.weight, 0.75);
  const noted = restored.edges.find((e) => e.type === "PREREQUISITE_OF");
  assert.equal(noted.props.note, "need this first");
});

await check("regenerates embeddings so search still works", async () => {
  // A restore that loses the vectors leaves a graph that reads fine and has
  // silently lost semantic search — the failure most likely to go unnoticed.
  const stats = await G.graphStats();
  assert.equal(stats.unembedded, 0, "some concepts came back without a vector");
  const hits = await G.hybridSearch("protocol for agreeing on a value", 5);
  assert.ok(
    hits.some((h) => h.name === "Raft" || h.name === "Paxos"),
    `semantic search found ${hits.map((h) => h.name)}`,
  );
});

await check("is idempotent — importing twice changes nothing", async () => {
  await restoreGraph(original);
  const twice = await exportGraph();
  const strip = (e) => ({ ...e, exportedAt: null });
  assert.deepEqual(strip(twice), strip(restored));
});

await check("rejects an unknown export format", async () => {
  await assert.rejects(
    () => restoreGraph({ ...original, format: "something-else/9" }),
    /Unsupported export format/,
  );
});

await check("reports edges whose endpoints are missing instead of dropping them", async () => {
  const broken = {
    ...original,
    edges: [...original.edges, { from: "no-such-node", to: raftId, type: "RELATED_TO", props: {} }],
  };
  const result = await restoreGraph(broken);
  assert.equal(result.skippedEdges, 1, "a dangling edge must be counted, not silently ignored");
});

// ── Markdown ─────────────────────────────────────────────────────────────────

section("markdown export");

await check("writes one file per concept with front matter and links", async () => {
  const files = toMarkdownFiles(original);
  assert.equal(files.length, original.nodes.Concept.length);
  const raft = files.find((f) => f.filename.startsWith("Raft"));
  assert.ok(raft.content.includes("---\nid: "), "front matter present");
  assert.ok(raft.content.includes("# Raft"), "heading present");
  assert.ok(raft.content.includes("日本語"), "body preserved");
  assert.ok(raft.content.includes("[["), "wiki links for an Obsidian vault");
});

await check("sanitises filenames Windows would reject", async () => {
  const files = toMarkdownFiles({
    ...original,
    nodes: { ...original.nodes, Concept: [{ id: "x", name: 'a/b:c*d?"e<f>g|h', body: "x" }] },
    edges: [],
  });
  assert.ok(!/[\\/:*?"<>|]/.test(files[0].filename), `got ${files[0].filename}`);
});

// ── Tombstones and the inbox ─────────────────────────────────────────────────
//
// Nothing had ever round-tripped a soft-deleted concept or a consumed inbox
// item, and three properties written as datetime() were missing from
// TEMPORAL_KEYS as a result: deletedAt, processedAt and undoneAt. A missing
// key exports fine and restores as a plain STRING, so the data survives with
// the wrong type — which is worse than losing it, because nothing complains.

section("tombstones and inbox");

const temporalType = async (match, prop) => {
  const r = await read(`MATCH ${match} RETURN valueType(x.${prop}) AS t`);
  return String(r.records[0]?.get("t") ?? "MISSING");
};

await check("a tombstoned concept and a consumed capture survive a round trip", async () => {
  await write("MATCH (n) DETACH DELETE n");

  const doomed = await G.upsertConcept({ name: "Doomed", body: "Will be tombstoned." });
  const keeper = await G.upsertConcept({ name: "Keeper", body: "Stays alive." });
  await G.linkConcepts(keeper.id, doomed.id, "RELATED_TO");
  await G.softDeleteConcept(doomed.id);

  await write(
    `CREATE (b:Inbox { id: 'inbox-done', text: 'already extracted', at: datetime(),
       processed: true, processedAt: datetime() })`,
  );

  const before = await exportGraph();
  assert.ok(
    before.nodes.Concept.some((c) => c.id === doomed.id),
    "a tombstone is recoverable data and must be exported",
  );

  await write("MATCH (n) DETACH DELETE n");
  await restoreGraph(before, { reEmbed: false });

  const deletedAtType = await temporalType(`(x:Concept {id: '${doomed.id}'})`, "deletedAt");
  assert.match(deletedAtType, /ZONED DATETIME|DATETIME/i,
    `deletedAt came back as ${deletedAtType}`);

  const processedAtType = await temporalType("(x:Inbox {id: 'inbox-done'})", "processedAt");
  assert.match(processedAtType, /ZONED DATETIME|DATETIME/i,
    `processedAt came back as ${processedAtType}`);
});

await check("the restored tombstone is still hidden, and still restorable", async () => {
  // The type matters because of what reads it: `WHERE c.deletedAt IS NULL`
  // happens to exclude a string too, so a wrong type hides rather than
  // breaks — which is exactly why it went unnoticed for three properties.
  const doomed = (await read("MATCH (c:Concept {name: 'Doomed'}) RETURN c.id AS id"))
    .records[0].get("id");

  assert.equal(await G.getConcept(doomed), null, "a tombstone must stay hidden");
  const search = await G.hybridSearch("tombstoned", 10);
  assert.ok(!search.some((r) => r.id === doomed), "and must not surface in search");

  await G.restoreConcept(doomed);
  const back = await G.getConcept(doomed);
  assert.ok(back, "restore must bring it back");
  assert.equal(back.name, "Doomed");
});

// ── Teardown ─────────────────────────────────────────────────────────────────

await getDriver().close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
