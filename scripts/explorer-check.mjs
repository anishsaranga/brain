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
const I = await import("@/lib/ingest");

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

// ── The maintenance surfaces, lifted out of inspect ──────────────────────────
//
// These four queries used to live inside `inspect` in tools.ts and were
// reachable only over MCP. The explorer needs the same answers, so they moved
// into graph.ts and both callers share them. What matters here is that they
// still respect soft delete: a tombstone reappearing on a maintenance page is
// exactly the kind of thing nobody notices.

section("the maintenance lists");

await check("listOrphans finds the unconnected and ignores tombstones", async () => {
  const ids = await fixture();
  const loose = await G.upsertConcept({ name: "Floating", body: "Links to nothing." });

  const before = await G.listOrphans();
  assert.ok(before.some((c) => c.id === loose.id), "an unlinked concept is an orphan");
  // Paxos has exactly one link, which counts: a concept joined to one other
  // is almost always the tail of a conversation nothing stitched in.
  assert.ok(before.some((c) => c.id === ids.paxos), "one link still counts");
  assert.ok(!before.some((c) => c.id === ids.raft), "Raft has three links");

  await G.softDeleteConcept(loose.id);
  const after = await G.listOrphans();
  assert.ok(!after.some((c) => c.id === loose.id), "a tombstone must not be listed");
});

await check("listFlagged shows only live flagged concepts", async () => {
  const ids = await fixture();
  assert.deepEqual(await G.listFlagged(), []);

  await G.setConceptFlags(ids.paxos, { flagged: true, flagNote: "Conflates two things." });
  const flagged = await G.listFlagged();
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].id, ids.paxos);
  assert.equal(flagged[0].note, "Conflates two things.");

  await G.softDeleteConcept(ids.paxos);
  assert.deepEqual(await G.listFlagged(), [], "a tombstone must not be listed");
});

await check("setConceptFlags can clear a flag again", async () => {
  const ids = await fixture();
  await G.setConceptFlags(ids.paxos, { flagged: true, flagNote: "wrong" });
  await G.setConceptFlags(ids.paxos, { flagged: false, flagNote: null });
  assert.deepEqual(await G.listFlagged(), []);
});

await check("setConceptFlags reports an unknown id rather than throwing", async () => {
  await fixture();
  assert.equal(await G.setConceptFlags("no-such-id", { flagged: true }), false);
});

await check("listStale covers tracked concepts only, and skips tombstones", async () => {
  const ids = await fixture();
  const stale = await G.listStale();
  assert.deepEqual(stale.map((c) => c.id), [ids.raft], "only Raft is tracked");
  assert.equal(stale[0].lastReview, null, "never reviewed");

  await G.softDeleteConcept(ids.raft);
  assert.deepEqual(await G.listStale(), []);
});

await check("listUntopiced finds concepts that the overview cannot show", async () => {
  const ids = await fixture();
  const loose = await G.listUntopiced();
  const names = loose.map((c) => c.name).sort();
  assert.deepEqual(names, ["Quorum", "Stale note"]);

  await G.softDeleteConcept(ids.quorum);
  assert.deepEqual((await G.listUntopiced()).map((c) => c.name), ["Stale note"]);
});

await check("navCounts agrees with the lists it summarises", async () => {
  const ids = await fixture();
  await G.setConceptFlags(ids.paxos, { flagged: true });
  await G.softDeleteConcept(ids.stale);

  const counts = await G.navCounts();
  assert.equal(counts.flagged, (await G.listFlagged()).length);
  assert.equal(counts.orphans, (await G.listOrphans()).length);
  assert.equal(counts.trash, (await G.listDeleted()).length);
  assert.equal(counts.trash, 1);
});

// ── The inbox, which had a write path and no reader ──────────────────────────

section("inbox");

await check("a capture round-trips to listInbox", async () => {
  await reset();
  const { id } = await I.capture("Read the Raft paper section 5.", "manual");
  const inbox = await G.listInbox();
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].id, id);
  assert.equal(inbox[0].text, "Read the Raft paper section 5.");
});

await check("a discarded capture leaves the inbox but is not destroyed", async () => {
  await reset();
  const { id } = await I.capture("Mis-captured.", "manual");
  assert.equal((await G.listInbox()).length, 1);

  const { discarded } = await I.discardCapture(id);
  assert.equal(discarded, true);
  assert.deepEqual(await G.listInbox(), []);

  const still = await read("MATCH (b:Inbox {id: $id}) RETURN b.text AS text", { id });
  assert.equal(still.records[0]?.get("text"), "Mis-captured.", "the text is kept");
});

await check("discarding twice is reported rather than silently succeeding", async () => {
  await reset();
  const { id } = await I.capture("Once.", "manual");
  await I.discardCapture(id);
  assert.deepEqual(await I.discardCapture(id), { discarded: false });
});

// ── Ingest batches: the 404 ──────────────────────────────────────────────────
//
// `remember` has returned reviewUrl pointing at /ingest/<batchId> since the
// first ingest, and the route did not exist. These cover the reader that page
// needs.

section("ingest batches");

async function ingestFixture() {
  await reset();
  return I.remember({
    concepts: [
      { name: "Vector clock", body: "Partial ordering of events.", topics: ["Distributed systems"] },
      { name: "Lamport timestamp", body: "A scalar logical clock." },
    ],
    links: [{ from: "Vector clock", to: "Lamport timestamp", type: "RELATED_TO" }],
    toolCaller: "check",
  });
}

await check("a batch is listed and readable by its id", async () => {
  const result = await ingestFixture();
  assert.ok(result.batchId, "the ingest wrote something");

  const listed = await G.listIngests();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, result.batchId);
  assert.equal(listed[0].created, 2);
  assert.equal(listed[0].undone, false);

  const batch = await G.getIngestBatch(result.batchId);
  assert.equal(batch.created, 2);
  assert.equal(batch.toolCaller, "check");
  assert.deepEqual(
    batch.createdConcepts.map((c) => c.name).sort(),
    ["Lamport timestamp", "Vector clock"],
  );
  assert.equal(batch.links.length, 1);
  assert.equal(batch.links[0].present, true, "the link it wrote is still there");
});

await check("an unknown batch id returns null rather than throwing", async () => {
  await reset();
  assert.equal(await G.getIngestBatch("00000000-0000-0000-0000-000000000000"), null);
});

await check("after an undo the batch still lists what it wrote, marked", async () => {
  const result = await ingestFixture();
  await I.undoIngest(result.batchId);

  const batch = await G.getIngestBatch(result.batchId);
  assert.equal(batch.undone, true);
  // The concepts must still be listed. Hiding them would show an empty batch,
  // which reads as data loss rather than a successful undo.
  assert.equal(batch.createdConcepts.length, 2);
  assert.ok(
    batch.createdConcepts.every((c) => c.deleted),
    "every created concept is now a tombstone",
  );
  assert.equal(batch.links[0].present, false, "the link was removed");
});

await check("a batch page survives a concept being destroyed outright", async () => {
  const result = await ingestFixture();
  await I.undoIngest(result.batchId);

  const trashed = await G.listDeleted();
  const victim = trashed.find((d) => d.name === "Vector clock");
  const gone = await G.hardDeleteConcept(victim.id, "Vector clock");
  assert.equal(gone.deleted, true);

  const batch = await G.getIngestBatch(result.batchId);
  assert.equal(batch.createdConcepts.length, 2, "the batch still records both");
  assert.ok(
    batch.createdConcepts.some((c) => c.name === "(destroyed)"),
    "the destroyed one is named as such rather than crashing the page",
  );
});

// ── Renaming, which used to fork the concept ─────────────────────────────────

section("rename");

await check("a rename moves the concept rather than creating a second one", async () => {
  const ids = await fixture();
  const { renamed } = await G.renameConcept(ids.raft, "Raft consensus");
  assert.equal(renamed, true);

  const after = await G.getConcept(ids.raft);
  assert.equal(after.name, "Raft consensus", "same id, new name");

  const all = await read(`MATCH (c:Concept) WHERE c.deletedAt IS NULL RETURN count(c) AS n`);
  assert.equal(all.records[0].get("n").toNumber(), 4, "no duplicate was created");

  // The links have to come with it, which they do only because the node
  // itself moved rather than a new one being merged into existence.
  const hood = await G.getNeighbourhood(ids.raft, 1);
  assert.equal(hood.nodes.length, 3);
});

await check("a case-only rename is applied", async () => {
  const ids = await fixture();
  await G.renameConcept(ids.quorum, "QUORUM");
  assert.equal((await G.getConcept(ids.quorum)).name, "QUORUM");
});

await check("a rename onto an existing name is refused with a reason", async () => {
  const ids = await fixture();
  const result = await G.renameConcept(ids.raft, "Paxos");
  assert.equal(result.renamed, false);
  assert.match(result.reason, /already exists/);
  assert.equal((await G.getConcept(ids.raft)).name, "Raft", "unchanged");
});

await check("renaming an unknown id is refused rather than throwing", async () => {
  await fixture();
  const result = await G.renameConcept("no-such-id", "Anything");
  assert.equal(result.renamed, false);
});

// ── The whole-graph view ─────────────────────────────────────────────────────

section("fullGraph");

await check("it returns live concepts with their degree", async () => {
  const ids = await fixture();
  const graph = await G.fullGraph();

  assert.equal(graph.nodes.length, 4);
  assert.equal(graph.truncated, false);
  assert.equal(graph.total, 4);

  const raft = graph.nodes.find((n) => n.id === ids.raft);
  assert.equal(raft.degree, 3, "Raft is joined to the other three");
  assert.equal(raft.tracked, true);
  assert.deepEqual(raft.topics, ["Distributed systems"]);

  assert.equal(graph.edges.length, 3);
});

await check("it excludes tombstones and the edges that touch them", async () => {
  const ids = await fixture();
  await G.softDeleteConcept(ids.paxos);

  const graph = await G.fullGraph();
  assert.equal(graph.nodes.length, 3);
  assert.ok(!graph.nodes.some((n) => n.id === ids.paxos));
  assert.equal(graph.edges.length, 2, "Raft to Paxos went with it");
  assert.equal(graph.nodes.find((n) => n.id === ids.raft).degree, 2);
});

await check("the cap reports itself instead of lying about the size", async () => {
  await fixture();
  const graph = await G.fullGraph(2);
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.truncated, true);
  assert.equal(graph.total, 4, "the real total is still reported");
  // Ordered by degree, so what survives a cap is the connected core rather
  // than an arbitrary slice.
  assert.ok(graph.nodes[0].degree >= graph.nodes[1].degree);
});

await check("an empty graph is empty rather than an error", async () => {
  await reset();
  const graph = await G.fullGraph();
  assert.deepEqual(graph, { nodes: [], edges: [], truncated: false, total: 0 });
});

await check("every topic comes back, not just the alphabetically first", async () => {
  await reset();
  await G.upsertConcept({
    name: "Sharding",
    body: "Partitioning.",
    topics: ["system-design", "databases", "interview"],
  });
  const graph = await G.fullGraph();
  assert.deepEqual(graph.nodes[0].topics, ["databases", "interview", "system-design"]);
});

// ── Walking the neighbourhood as something to read ───────────────────────────

section("neighbourhoodNotes");

await check("one hop out comes back with the bodies", async () => {
  const ids = await fixture();
  const walk = await G.neighbourhoodNotes(ids.raft, 1);

  assert.equal(walk.center.id, ids.raft);
  assert.equal(walk.items.length, 3);
  assert.equal(walk.truncated, false);
  assert.ok(walk.items.every((i) => i.hop === 1));
  const paxos = walk.items.find((i) => i.concept.id === ids.paxos);
  assert.equal(paxos.concept.body, "Earlier consensus protocol.");
});

await check("a second hop is reached and numbered", async () => {
  const ids = await fixture();
  const walk = await G.neighbourhoodNotes(ids.quorum, 2);

  const hops = new Map(walk.items.map((i) => [i.concept.id, i.hop]));
  assert.equal(hops.get(ids.raft), 1, "Raft is one link from Quorum");
  assert.equal(hops.get(ids.paxos), 2, "Paxos is two");
  assert.equal(hops.get(ids.stale), 2);
  assert.equal(hops.size, 3);
});

await check("the centre is never in its own walk", async () => {
  const ids = await fixture();
  const walk = await G.neighbourhoodNotes(ids.raft, 3);
  assert.ok(!walk.items.some((i) => i.concept.id === ids.raft));
});

await check("each note says what it hangs off, and which way", async () => {
  const ids = await fixture();
  const walk = await G.neighbourhoodNotes(ids.raft, 1);

  // Quorum is a PREREQUISITE_OF Raft, so from Quorum's side the relation
  // points away from it: "this note, prerequisite of, Raft".
  const quorum = walk.items.find((i) => i.concept.id === ids.quorum);
  assert.equal(quorum.via.id, ids.raft);
  assert.equal(quorum.via.name, "Raft");
  assert.equal(quorum.via.type, "PREREQUISITE_OF");
  assert.equal(quorum.via.incoming, false, "the arrow leaves Quorum");
});

await check("direction is read from the relationship, not assumed", async () => {
  await reset();
  const cause = await G.upsertConcept({ name: "Cause", body: "First." });
  const effect = await G.upsertConcept({ name: "Effect", body: "Second." });
  await G.linkConcepts(cause.id, effect.id, "PREREQUISITE_OF");

  // `incoming` is relative to the NOTE BEING READ, not to the note you
  // started from. Walking out from Effect, the note you are reading is
  // Cause, and the arrow leaves Cause: "this note, prerequisite of, Effect".
  const fromEffect = await G.neighbourhoodNotes(effect.id, 1);
  assert.equal(fromEffect.items[0].concept.id, cause.id);
  assert.equal(fromEffect.items[0].via.incoming, false, "the arrow leaves Cause");

  // The other way round, the note being read is Effect and the arrow points
  // at it: "Cause, prerequisite of, this note".
  const fromCause = await G.neighbourhoodNotes(cause.id, 1);
  assert.equal(fromCause.items[0].concept.id, effect.id);
  assert.equal(fromCause.items[0].via.incoming, true, "the arrow points at Effect");
});

await check("a tombstone is not in the walk, and is not walked through", async () => {
  const ids = await fixture();
  await G.softDeleteConcept(ids.raft);

  const walk = await G.neighbourhoodNotes(ids.quorum, 3);
  assert.equal(walk.items.length, 0, "Raft was the only way out of Quorum");
});

await check("the cap stops the walk and says so", async () => {
  const ids = await fixture();
  const walk = await G.neighbourhoodNotes(ids.raft, 1, 2);
  assert.equal(walk.items.length, 2);
  assert.equal(walk.truncated, true);
});

await check("a concept with no links is an empty walk, not an error", async () => {
  await reset();
  const lonely = await G.upsertConcept({ name: "Lonely", body: "Nothing links here." });
  const walk = await G.neighbourhoodNotes(lonely.id, 3);
  assert.deepEqual(walk.items, []);
  assert.equal(walk.truncated, false);
});

await check("an unknown id is null rather than a crash", async () => {
  await reset();
  assert.equal(await G.neighbourhoodNotes("no-such-id", 1), null);
});

// ── The topic leak ───────────────────────────────────────────────────────────
//
// PART_OF is both a concept-to-concept relation and the concept-to-topic
// edge, so a variable-length match that does not constrain what it passes
// through walks Concept -> Topic -> Concept and calls everything sharing a
// tag a 2-hop neighbour. On the real graph that was 135 neighbours where
// there are 102, with the cap then dropping real links to make room.

section("sharing a topic is not a link");

await check("two concepts with the same topic and no link are not neighbours", async () => {
  await reset();
  const a = await G.upsertConcept({ name: "Alpha", body: "One.", topics: ["shared"] });
  const b = await G.upsertConcept({ name: "Beta", body: "Two.", topics: ["shared"] });

  const walk = await G.neighbourhoodNotes(a.id, 3);
  assert.deepEqual(walk.items, [], "reached Beta through the Topic node");

  const hood = await G.getNeighbourhood(a.id, 3);
  assert.deepEqual(
    hood.nodes.map((n) => n.id),
    [],
    "getNeighbourhood walked through the Topic node",
  );
  assert.ok(b.id, "fixture sanity");
});

await check("a concept-to-concept PART_OF still counts as a link", async () => {
  await reset();
  const part = await G.upsertConcept({ name: "Wheel", body: "Round." });
  const whole = await G.upsertConcept({ name: "Car", body: "Drives." });
  await G.linkConcepts(part.id, whole.id, "PART_OF");

  const walk = await G.neighbourhoodNotes(part.id, 1);
  assert.deepEqual(walk.items.map((i) => i.concept.id), [whole.id]);

  const hood = await G.getNeighbourhood(part.id, 1);
  assert.deepEqual(hood.nodes.map((n) => n.id), [whole.id]);
});

// ── Enrolling a note in review ───────────────────────────────────────────────

section("setTracked");

await check("enrols an untracked concept, and takes it out again", async () => {
  const ids = await fixture();

  const on = await G.setTracked(ids.paxos, true);
  assert.deepEqual(on, { tracked: true, prompt: null });
  assert.equal((await G.getConcept(ids.paxos)).tracked, true);

  const off = await G.setTracked(ids.paxos, false);
  assert.equal(off.tracked, false);
  assert.equal((await G.getConcept(ids.paxos)).tracked, false);
});

await check("enrolling writes no revision", async () => {
  const ids = await fixture();
  const before = await G.getRevisions(ids.paxos);

  await G.setTracked(ids.paxos, true, { prompt: "What does Paxos guarantee?" });

  const after = await G.getRevisions(ids.paxos);
  assert.deepEqual(
    after,
    before,
    "tracking is not an edit; the editor's Save keeps history, this must not",
  );
});

await check("enrolling does not disturb the embedding", async () => {
  const ids = await fixture();
  const hashOf = async (id) => {
    const r = await read("MATCH (c:Concept {id: $id}) RETURN c.textHash AS h", { id });
    return r.records[0].get("h");
  };
  const before = await hashOf(ids.paxos);

  await G.setTracked(ids.paxos, true, { prompt: "Why a majority?" });

  assert.equal(
    await hashOf(ids.paxos),
    before,
    "the prompt is not part of the embedded text, so the hash must not move",
  );
});

await check("a tombstone cannot be put into review", async () => {
  const ids = await fixture();
  await G.softDeleteConcept(ids.stale);

  assert.equal(await G.setTracked(ids.stale, true), null);

  const raw = await read("MATCH (c:Concept {id: $id}) RETURN c.tracked AS t", {
    id: ids.stale,
  });
  assert.notEqual(raw.records[0].get("t"), true, "a note you threw away is not a card");
});

await check("an unknown id returns null rather than throwing", async () => {
  await fixture();
  assert.equal(await G.setTracked("00000000-0000-0000-0000-000000000000", true), null);
});

await check("the prompt is written, kept, and only cleared on purpose", async () => {
  const ids = await fixture();

  await G.setTracked(ids.paxos, true, { prompt: "  Why a majority?  " });
  assert.equal((await G.getConcept(ids.paxos)).prompt, "  Why a majority?  ");

  // Omitting it must leave it alone, or toggling off and on would wipe it.
  await G.setTracked(ids.paxos, false);
  await G.setTracked(ids.paxos, true);
  assert.equal((await G.getConcept(ids.paxos)).prompt, "  Why a majority?  ");

  await G.setTracked(ids.paxos, true, { prompt: null });
  assert.equal((await G.getConcept(ids.paxos)).prompt, null);
});

// ── Teardown ─────────────────────────────────────────────────────────────────

await getDriver().close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
