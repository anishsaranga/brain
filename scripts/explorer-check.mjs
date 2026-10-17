/**
 * Checks for the explorer's data layer.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   npm run explorer:check
 *
 * Two things matter here more than the rest.
 *
 * Soft delete: every new read path has to exclude tombstones, and a forgotten
 * predicate shows up as deleted concepts quietly reappearing rather than as
 * an error. The explorer added five read paths at once.
 *
 * Hard delete: the only irreversible operation in the system. Its guards are
 * enforced in `hardDeleteConcept`, not in the form, and that is exactly what
 * needs proving — a guard that lives only in a React component is one a
 * stray fetch never has to pass.
 *
 * Exits 1 on any failure.
 */
import assert from "node:assert/strict";

const TEST_URI = process.env.NEO4J_URI ?? "bolt://localhost:7688";

const ALLOWED = [
  /^bolt:\/\/(localhost|127\.0\.0\.1):7688$/,
  /^bolt:\/\/brain-neo4j-test:7687$/,
];
if (!ALLOWED.some((re) => re.test(TEST_URI))) {
  console.error(`REFUSING TO RUN: ${TEST_URI} is not a recognised throwaway target.`);
  process.exit(1);
}

process.env.NEO4J_URI = TEST_URI;
process.env.NEO4J_USER = process.env.NEO4J_USER ?? "neo4j";
process.env.NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? "testpassword";
process.env.MODEL_DIR = process.env.MODEL_DIR ?? "./.models";
process.env.ALLOW_REMOTE_MODELS = process.env.ALLOW_REMOTE_MODELS ?? "1";

const { getDriver, read, write, waitForNeo4j } = await import("@/lib/neo4j");
const { ensureSchema } = await import("@/lib/schema");
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
const reset = () => write("MATCH (n) DETACH DELETE n");

console.log(`explorer-check against ${TEST_URI}`);
await waitForNeo4j({ attempts: 40, delayMs: 2000 });
await ensureSchema();

/** Raft at the centre, three neighbours, one of them doomed. */
async function fixture() {
  await reset();
  const raft = await G.upsertConcept({
    name: "Raft",
    body: "A consensus protocol.",
    topics: ["Distributed systems"],
    tracked: true,
  });
  const paxos = await G.upsertConcept({
    name: "Paxos",
    body: "Earlier consensus protocol.",
    topics: ["Distributed systems"],
  });
  const quorum = await G.upsertConcept({ name: "Quorum", body: "A majority." });
  const stale = await G.upsertConcept({ name: "Stale note", body: "To be deleted." });

  await G.linkConcepts(quorum.id, raft.id, "PREREQUISITE_OF");
  await G.linkConcepts(raft.id, paxos.id, "CONTRASTS_WITH");
  await G.linkConcepts(raft.id, stale.id, "RELATED_TO");

  return { raft: raft.id, paxos: paxos.id, quorum: quorum.id, stale: stale.id };
}

// ── Soft delete must be respected by every new read path ─────────────────────

section("soft delete across the explorer's read paths");

await check("a tombstone disappears from the topic overview counts", async () => {
  const ids = await fixture();
  const before = await G.topicOverview();
  const ds = before.topics.find((t) => t.name === "Distributed systems");
  assert.equal(ds.concepts, 2);

  await G.softDeleteConcept(ids.paxos);
  const after = await G.topicOverview();
  assert.equal(after.topics.find((t) => t.name === "Distributed systems").concepts, 1);
});

await check("a tombstone disappears from the topic listing", async () => {
  const ids = await fixture();
  await G.softDeleteConcept(ids.paxos);
  const listed = await G.conceptsInTopic("Distributed systems");
  assert.deepEqual(listed.map((c) => c.id), [ids.raft]);
});

await check("a tombstone disappears from recent concepts", async () => {
  const ids = await fixture();
  await G.softDeleteConcept(ids.stale);
  const recent = await G.recentConcepts(20);
  assert.ok(!recent.some((c) => c.id === ids.stale));
  assert.equal(recent.length, 3);
});

await check("a tombstone disappears from link suggestions", async () => {
  const ids = await fixture();
  // Quorum and Paxos are linked to Raft; Stale note is too. Add an unlinked
  // one so there is something to suggest in the first place.
  const loose = await G.upsertConcept({ name: "Replicated log", body: "Ordered durable sequence." });
  const before = await G.unlinkedNeighbours(ids.raft, 10);
  assert.ok(before.some((c) => c.id === loose.id), "an unlinked concept should be suggested");

  await G.softDeleteConcept(loose.id);
  const after = await G.unlinkedNeighbours(ids.raft, 10);
  assert.ok(!after.some((c) => c.id === loose.id), "a tombstone must not be suggested");
});

await check("the untopiced count ignores tombstones", async () => {
  const ids = await fixture();
  const before = await G.topicOverview();
  assert.equal(before.untopiced, 2, "Quorum and Stale note have no topic");
  await G.softDeleteConcept(ids.stale);
  assert.equal((await G.topicOverview()).untopiced, 1);
});

// ── The trash view, which deliberately looks past it ─────────────────────────

section("trash");

await check("listDeleted shows tombstones and only tombstones", async () => {
  const ids = await fixture();
  assert.deepEqual(await G.listDeleted(), []);

  await G.softDeleteConcept(ids.stale);
  const trash = await G.listDeleted();
  assert.equal(trash.length, 1);
  assert.equal(trash[0].id, ids.stale);
  assert.equal(trash[0].name, "Stale note");
  assert.equal(trash[0].edges, 1, "edges survive a tombstone and are reported");
});

await check("deletionImpact names the live concepts that lose a link", async () => {
  const ids = await fixture();
  await G.softDeleteConcept(ids.raft);
  const impact = await G.deletionImpact(ids.raft);

  assert.equal(impact.name, "Raft");
  const names = impact.severs.map((s) => s.name).sort();
  assert.deepEqual(names, ["Paxos", "Quorum", "Stale note"]);
});

await check("deletionImpact ignores neighbours that are themselves tombstoned", async () => {
  const ids = await fixture();
  await G.softDeleteConcept(ids.stale);
  await G.softDeleteConcept(ids.raft);
  const impact = await G.deletionImpact(ids.raft);
  assert.deepEqual(impact.severs.map((s) => s.name).sort(), ["Paxos", "Quorum"]);
});

// ── Hard delete: the one irreversible path ───────────────────────────────────

section("hard delete");

await check("it refuses a concept that is not in the trash", async () => {
  const ids = await fixture();
  const result = await G.hardDeleteConcept(ids.raft, "Raft");
  assert.equal(result.deleted, false);
  assert.match(result.reason, /Delete it first/);

  assert.ok(await G.getConcept(ids.raft), "and the concept is untouched");
});

await check("it refuses when the typed name does not match", async () => {
  const ids = await fixture();
  await G.softDeleteConcept(ids.stale);

  for (const wrong of ["", "stale note", "Stale  note", "Stale", "Raft"]) {
    const result = await G.hardDeleteConcept(ids.stale, wrong);
    assert.equal(result.deleted, false, `"${wrong}" must not confirm`);
    assert.match(result.reason, /does not match/);
  }
  assert.equal((await G.listDeleted()).length, 1, "still in the trash");
});

await check("it destroys exactly the named concept and its edges", async () => {
  const ids = await fixture();
  await G.softDeleteConcept(ids.stale);

  const result = await G.hardDeleteConcept(ids.stale, "Stale note");
  assert.equal(result.deleted, true);
  assert.equal(result.name, "Stale note");

  const gone = await read("MATCH (c:Concept {id: $id}) RETURN count(c) AS n", { id: ids.stale });
  assert.equal(gone.records[0].get("n").toNumber(), 0, "the node is gone");

  // Everything else survives, including the edges between the survivors.
  const left = await read("MATCH (c:Concept) RETURN count(c) AS n");
  assert.equal(left.records[0].get("n").toNumber(), 3);
  const edges = await read("MATCH (:Concept)-[r]->(:Concept) RETURN count(r) AS n");
  assert.equal(edges.records[0].get("n").toNumber(), 2, "only Stale note's edge went");

  assert.ok(await G.getConcept(ids.raft), "Raft is untouched");
});

await check("surrounding whitespace in the typed name is tolerated", async () => {
  const ids = await fixture();
  await G.softDeleteConcept(ids.stale);
  const result = await G.hardDeleteConcept(ids.stale, "  Stale note  ");
  assert.equal(result.deleted, true);
});

await check("an unknown id is refused rather than throwing", async () => {
  await fixture();
  const result = await G.hardDeleteConcept("no-such-id", "anything");
  assert.equal(result.deleted, false);
  assert.match(result.reason, /No concept/);
});

// ── Unlinking ────────────────────────────────────────────────────────────────

section("unlink");

await check("it removes one relationship and leaves the concepts", async () => {
  const ids = await fixture();
  const { removed } = await G.unlinkConcepts(ids.raft, ids.paxos, "CONTRASTS_WITH");
  assert.equal(removed, true);

  assert.ok(await G.getConcept(ids.raft));
  assert.ok(await G.getConcept(ids.paxos));

  const edges = await read("MATCH (:Concept)-[r]->(:Concept) RETURN count(r) AS n");
  assert.equal(edges.records[0].get("n").toNumber(), 2, "the other two survive");
});

await check("it works regardless of which end you name first", async () => {
  const ids = await fixture();
  // quorum -PREREQUISITE_OF-> raft, asked for the other way round.
  const { removed } = await G.unlinkConcepts(ids.raft, ids.quorum, "PREREQUISITE_OF");
  assert.equal(removed, true);
});

await check("removing a link that is not there is reported, not thrown", async () => {
  const ids = await fixture();
  assert.deepEqual(await G.unlinkConcepts(ids.raft, ids.quorum, "CITES"), { removed: false });
});

await check("an unknown relationship type is refused", async () => {
  const ids = await fixture();
  await assert.rejects(() => G.unlinkConcepts(ids.raft, ids.paxos, "MADE_UP"));
});

// ── Teardown ─────────────────────────────────────────────────────────────────

await getDriver().close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
