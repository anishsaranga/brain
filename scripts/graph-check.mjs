/**
 * Behavioural checks for the graph core: upsert/merge semantics, the closed
 * relationship vocabulary, bounded neighbourhoods, embeddings, and hybrid
 * search.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   npm run graph:check
 *   docker compose -f docker-compose.test.yml down
 *
 * Exits 1 if any check fails. The alias hook resolves `@/…` and stubs
 * `server-only`.
 *
 * Runs against the THROWAWAY Neo4j on 7688, never the real one on 7687 — see
 * the guard below. There is no UI over this layer yet and the MCP tools are
 * still a milestone away, so this script is the only thing exercising it.
 */
import assert from "node:assert/strict";

const TEST_URI = process.env.NEO4J_URI ?? "bolt://localhost:7688";

/**
 * The production graph is the one thing on this box that cannot be rebuilt
 * from a repo, and the first thing this script does is `DETACH DELETE` every
 * node. So the guard is an ALLOWLIST, not a denylist: anything not positively
 * recognised as the throwaway server is refused.
 *
 * A denylist on ":7687" would have been wrong — inside the compose network the
 * test server listens on 7687 too, and only the hostname distinguishes them.
 */
const ALLOWED_TEST_TARGETS = [
  /^bolt:\/\/(localhost|127\.0\.0\.1):7688$/, // from the host
  /^bolt:\/\/brain-neo4j-test:7687$/, // from inside the compose network
];

if (!ALLOWED_TEST_TARGETS.some((re) => re.test(TEST_URI))) {
  console.error(
    `REFUSING TO RUN: NEO4J_URI is ${TEST_URI}, which is not a recognised\n` +
      `throwaway target. This script deletes every node it can reach.\n\n` +
      `Allowed: bolt://localhost:7688, bolt://127.0.0.1:7688,\n` +
      `         bolt://brain-neo4j-test:7687\n\n` +
      `Run it with:  npm run graph:check`,
  );
  process.exit(1);
}

process.env.NEO4J_URI = TEST_URI;
process.env.NEO4J_USER = process.env.NEO4J_USER ?? "neo4j";
process.env.NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? "testpassword";
// The model is baked into the image at /app/models; outside the container it
// lives in the repo-local cache that `npm run model:bake` populates.
process.env.MODEL_DIR = process.env.MODEL_DIR ?? "./.models";
process.env.ALLOW_REMOTE_MODELS = process.env.ALLOW_REMOTE_MODELS ?? "1";

const { getDriver, write, waitForNeo4j } = await import("@/lib/neo4j");
const { ensureSchema } = await import("@/lib/schema");
const G = await import("@/lib/graph");
const E = await import("@/lib/embeddings");

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

function section(title) {
  console.log(`\n${title}`);
}

// ── Setup ────────────────────────────────────────────────────────────────────

console.log(`graph-check against ${TEST_URI}`);
await waitForNeo4j({ attempts: 40, delayMs: 2000 });
await ensureSchema();
// Fresh slate every run; this server is disposable.
await write("MATCH (n) DETACH DELETE n");

// ── Embeddings ───────────────────────────────────────────────────────────────

section("embeddings");

await check("produces a 384-dim finite unit vector", async () => {
  const vec = await E.embed("consensus in distributed systems");
  assert.equal(vec.length, 384, "dimension must match the vector index");
  assert.ok(vec.every(Number.isFinite), "all components finite");
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-3, `expected unit length, got ${norm}`);
});

await check("is deterministic for the same input", async () => {
  const [a, b] = await Promise.all([E.embed("idempotency"), E.embed("idempotency")]);
  assert.deepEqual(a, b);
});

await check("ranks a paraphrase above an unrelated sentence", async () => {
  const dot = (p, q) => p.reduce((s, x, i) => s + x * q[i], 0);
  const [anchor, para, unrelated] = await E.embedBatch([
    "retrying a request must not change the result twice",
    "an operation that can safely be repeated without side effects",
    "sourdough needs a long cold proof in the fridge",
  ]);
  const near = dot(anchor, para);
  const far = dot(anchor, unrelated);
  assert.ok(near > far, `paraphrase ${near.toFixed(3)} should beat ${far.toFixed(3)}`);
});

await check("skips re-embedding when the text is unchanged", async () => {
  const a = E.embeddingText({ name: "Raft", aliases: ["raft"], body: "A consensus protocol." });
  const b = E.embeddingText({ name: "Raft", aliases: ["raft"], body: "A consensus protocol." });
  assert.equal(E.embeddingHash(a), E.embeddingHash(b));
  const c = E.embeddingText({ name: "Raft", aliases: ["raft"], body: "Changed." });
  assert.notEqual(E.embeddingHash(a), E.embeddingHash(c));
});

// ── Upsert ───────────────────────────────────────────────────────────────────

section("upsertConcept");

let raftId;

await check("creates a concept", async () => {
  const res = await G.upsertConcept({
    name: "Raft",
    aliases: ["Raft consensus"],
    body: "A consensus protocol built around an elected leader and a replicated log.",
    topics: ["Distributed systems"],
  });
  assert.equal(res.created, true);
  assert.equal(res.reEmbedded, true);
  raftId = res.id;
});

await check("updates rather than duplicating on the same name", async () => {
  const res = await G.upsertConcept({ name: "Raft", body: "Updated body." });
  assert.equal(res.created, false);
  assert.equal(res.id, raftId, "same node");
  const { records } = await (await import("@/lib/neo4j")).read(
    "MATCH (c:Concept {name:'Raft'}) RETURN count(c) AS n",
  );
  assert.equal(records[0].get("n").toNumber(), 1, "exactly one Raft node");
});

await check("does not drop the embedding on an unrelated update", async () => {
  const before = await G.upsertConcept({ name: "Raft", body: "Updated body." });
  assert.equal(before.reEmbedded, false, "identical text must not re-embed");
  const { records } = await (await import("@/lib/neo4j")).read(
    "MATCH (c:Concept {name:'Raft'}) RETURN c.embedding IS NOT NULL AS hasVec",
  );
  assert.equal(records[0].get("hasVec"), true, "vector survived the update");
});

await check("survives a concurrent double-upsert of the same new name", async () => {
  const [a, b] = await Promise.all([
    G.upsertConcept({ name: "Vector clocks", body: "Partial ordering of events." }),
    G.upsertConcept({ name: "Vector clocks", body: "Partial ordering of events." }),
  ]);
  assert.equal(a.id, b.id, "both calls resolve to one node");
  const { records } = await (await import("@/lib/neo4j")).read(
    "MATCH (c:Concept {name:'Vector clocks'}) RETURN count(c) AS n",
  );
  assert.equal(records[0].get("n").toNumber(), 1);
});

await check("rejects an empty name", async () => {
  await assert.rejects(() => G.upsertConcept({ name: "   " }));
});

await check("attaches topics", async () => {
  const c = await G.getConcept("Raft");
  assert.ok(c.topics.includes("Distributed systems"), `topics: ${c.topics}`);
});

await check("finds a concept by alias", async () => {
  const c = await G.getConcept("Raft consensus");
  assert.equal(c.id, raftId);
});

await check("a partial update does not erase omitted fields", async () => {
  // Regression. `remember` is called from many independent conversations; one
  // that mentions a concept without repeating its body or aliases must not
  // wipe what an earlier one wrote. An omitted field means "leave it alone".
  await G.upsertConcept({
    name: "Partial",
    aliases: ["first alias"],
    body: "Original body.",
    prompt: "Original prompt?",
  });
  await G.upsertConcept({ name: "Partial", aliases: ["second alias"] });

  const c = await G.getConcept("Partial");
  assert.equal(c.body, "Original body.", "body survived an update that omitted it");
  assert.equal(c.prompt, "Original prompt?", "prompt survived");
  assert.deepEqual(
    [...c.aliases].sort(),
    ["first alias", "second alias"],
    "aliases accumulate rather than replace",
  );
});

// ── Relationships ────────────────────────────────────────────────────────────

section("linkConcepts");

await check("links with every type in the vocabulary", async () => {
  for (const type of G.REL_TYPES) {
    if (type === "CITES") continue; // Concept -> Source, covered separately
    const a = await G.upsertConcept({ name: `A_${type}`, body: "left" });
    const b = await G.upsertConcept({ name: `B_${type}`, body: "right" });
    await G.linkConcepts(a.id, b.id, type);
    const { records } = await (await import("@/lib/neo4j")).read(
      `MATCH (:Concept {id:$a})-[r:${type}]->(:Concept {id:$b}) RETURN count(r) AS n`,
      { a: a.id, b: b.id },
    );
    assert.equal(records[0].get("n").toNumber(), 1, `${type} did not link`);
  }
});

await check("rejects a relationship type outside the vocabulary", async () => {
  const a = await G.getConcept("Raft");
  const b = await G.getConcept("Vector clocks");
  await assert.rejects(
    () => G.linkConcepts(a.id, b.id, "RELATES_TO"),
    /Unknown relationship type/,
    "the drift-prone near-miss must be refused",
  );
});

await check("refuses a self-link", async () => {
  await assert.rejects(() => G.linkConcepts(raftId, raftId, "RELATED_TO"));
});

await check("is idempotent — relinking does not duplicate", async () => {
  const a = await G.getConcept("Raft");
  const b = await G.getConcept("Vector clocks");
  await G.linkConcepts(a.id, b.id, "RELATED_TO");
  await G.linkConcepts(a.id, b.id, "RELATED_TO");
  const { records } = await (await import("@/lib/neo4j")).read(
    "MATCH (:Concept {id:$a})-[r:RELATED_TO]->(:Concept {id:$b}) RETURN count(r) AS n",
    { a: a.id, b: b.id },
  );
  assert.equal(records[0].get("n").toNumber(), 1);
});

await check("reinforceEdge records a traversal", async () => {
  const a = await G.getConcept("Raft");
  const b = await G.getConcept("Vector clocks");
  await G.reinforceEdge(a.id, b.id, "RELATED_TO");
  const { records } = await (await import("@/lib/neo4j")).read(
    "MATCH (:Concept {id:$a})-[r:RELATED_TO]-(:Concept {id:$b}) RETURN r.traversals AS t, r.reinforcedAt IS NOT NULL AS at",
    { a: a.id, b: b.id },
  );
  assert.equal(records[0].get("t").toNumber(), 1);
  assert.equal(records[0].get("at"), true);
});

// ── Neighbourhood ────────────────────────────────────────────────────────────

section("getNeighbourhood");

await check("respects depth", async () => {
  const one = await G.upsertConcept({ name: "Hop1", body: "one" });
  const two = await G.upsertConcept({ name: "Hop2", body: "two" });
  const three = await G.upsertConcept({ name: "Hop3", body: "three" });
  await G.linkConcepts(one.id, two.id, "PREREQUISITE_OF");
  await G.linkConcepts(two.id, three.id, "PREREQUISITE_OF");

  const d1 = await G.getNeighbourhood(one.id, 1, 50);
  const names1 = d1.nodes.map((n) => n.name);
  assert.ok(names1.includes("Hop2"), "depth 1 reaches Hop2");
  assert.ok(!names1.includes("Hop3"), "depth 1 must not reach Hop3");

  const d2 = await G.getNeighbourhood(one.id, 2, 50);
  const names2 = d2.nodes.map((n) => n.name);
  assert.ok(names2.includes("Hop3"), "depth 2 reaches Hop3");
});

await check("returns the induced edges, not just nodes", async () => {
  const one = await G.getConcept("Hop1");
  const nb = await G.getNeighbourhood(one.id, 2, 50);
  const types = nb.edges.map((e) => e.type);
  assert.ok(types.includes("PREREQUISITE_OF"), `edges: ${JSON.stringify(types)}`);
});

await check("honours the limit and flags truncation", async () => {
  const hub = await G.upsertConcept({ name: "Hub", body: "many edges" });
  for (let i = 0; i < 12; i++) {
    const leaf = await G.upsertConcept({ name: `Leaf ${i}`, body: `leaf ${i}` });
    await G.linkConcepts(hub.id, leaf.id, "PART_OF");
  }
  const capped = await G.getNeighbourhood(hub.id, 1, 5);
  assert.equal(capped.nodes.length, 5, "limit respected");
  assert.equal(capped.truncated, true, "truncation reported, not hidden");

  const full = await G.getNeighbourhood(hub.id, 1, 50);
  assert.equal(full.nodes.length, 12);
  assert.equal(full.truncated, false);
});

await check("clamps an absurd depth instead of throwing", async () => {
  const nb = await G.getNeighbourhood(raftId, 99, 10);
  assert.ok(nb, "clamped to the 1..3 range rather than erroring");
});

await check("returns null for an unknown id", async () => {
  assert.equal(await G.getNeighbourhood("no-such-id", 1, 10), null);
});

// ── Search ───────────────────────────────────────────────────────────────────

section("hybridSearch");

await check("finds a concept by exact jargon (full-text path)", async () => {
  const hits = await G.hybridSearch("Raft", 5);
  assert.ok(hits.some((h) => h.name === "Raft"), `got ${hits.map((h) => h.name)}`);
});

await check("finds a concept by paraphrase (vector path)", async () => {
  await G.upsertConcept({
    name: "Backpressure",
    body: "When a consumer cannot keep up, the system signals the producer to slow down instead of buffering without bound.",
  });
  const hits = await G.hybridSearch("what happens when a reader is too slow", 5);
  assert.ok(
    hits.some((h) => h.name === "Backpressure"),
    `got ${hits.map((h) => h.name)}`,
  );
});

await check("survives Lucene metacharacters in the query", async () => {
  // The regression this module is most likely to need: these are ordinary
  // things to type, and unescaped they are a Lucene parse error that takes
  // the whole search down.
  for (const q of [
    "Foo::Bar",
    "big-O (amortised)",
    'what is "consensus"?',
    "a/b testing",
    "c++ templates",
    "why not~",
    "[draft] notes",
  ]) {
    const hits = await G.hybridSearch(q, 3);
    assert.ok(Array.isArray(hits), `query ${q} did not return an array`);
  }
});

await check("reports which retriever found each hit", async () => {
  const hits = await G.hybridSearch("Raft", 5);
  assert.ok(hits.length > 0);
  assert.ok(hits.every((h) => h.sources.length > 0), "sources recorded");
});

await check("findSimilar excludes the node itself", async () => {
  const vec = await E.embed("a consensus protocol with an elected leader");
  const similar = await G.findSimilar(vec, { excludeIds: [raftId], limit: 5 });
  assert.ok(!similar.some((s) => s.id === raftId), "excluded id must not appear");
});

// ── Stats ────────────────────────────────────────────────────────────────────

section("graphStats");

await check("counts concepts, edges, untracked and orphans", async () => {
  const stats = await G.graphStats();
  assert.ok(stats.concepts > 0, "some concepts");
  assert.ok(stats.edges > 0, "some edges");
  assert.equal(stats.untracked, stats.concepts, "nothing is tracked by default");
  assert.equal(stats.unembedded, 0, "every concept got a vector");
  assert.ok(stats.orphans >= 0);
});

await check("storage and rehearsal are separate — nothing auto-tracks", async () => {
  const c = await G.getConcept("Raft");
  assert.equal(c.tracked, false, "an ingested concept is not a flashcard");
});

// ── Teardown ─────────────────────────────────────────────────────────────────

await getDriver().close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
