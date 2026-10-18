/**
 * Checks for community detection.
 *
 *   npm run cluster:check
 *
 * No database and no container: one pure function, so it runs on the host in
 * well under a second.
 *
 * The property worth defending here is not "the communities are good" — that
 * is a judgement and you make it by looking at the canvas. It is that the
 * answer is the SAME ANSWER every time. The graph view seeds its layout from
 * these clusters precisely so the picture holds still between reloads, and a
 * clustering that drifted with the order rows came back from Neo4j would undo
 * that silently: no error, no warning, just a graph you can never learn the
 * shape of.
 *
 * Exits 1 on any failure.
 */
import assert from "node:assert/strict";

const { cluster, clusterAt } = await import("@/lib/clusters");

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err && err.message ? err.message : err}`);
  }
}

const section = (t) => console.log(`\n${t}`);

/** A clique over the given ids. */
function clique(ids) {
  const edges = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) edges.push({ from: ids[i], to: ids[j] });
  }
  return edges;
}

/** k cliques of `size`, chained by one edge between consecutive cliques. */
function planted(k, size) {
  const nodes = [];
  const edges = [];
  for (let c = 0; c < k; c++) {
    const ids = Array.from({ length: size }, (_, i) => `c${c}n${i}`);
    for (const id of ids) nodes.push({ id });
    edges.push(...clique(ids));
    if (c > 0) edges.push({ from: `c${c - 1}n0`, to: `c${c}n0` });
  }
  return { nodes, edges };
}

/** Deterministic shuffle, so a reordering test is itself reproducible. */
function shuffled(list, seed) {
  const out = [...list];
  let h = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const shape = (result) => result.clusters.map((c) => c.join(","));

console.log("cluster-check");

// ── Determinism ──────────────────────────────────────────────────────────────

section("the same graph always clusters the same way");

check("the result does not depend on node or edge order", () => {
  const { nodes, edges } = planted(5, 6);
  const base = shape(cluster(nodes, edges));
  for (let seed = 1; seed <= 6; seed++) {
    const other = shape(cluster(shuffled(nodes, seed), shuffled(edges, seed * 31)));
    assert.deepEqual(other, base, `reordering with seed ${seed} changed the clustering`);
  }
});

check("repeated calls agree", () => {
  const { nodes, edges } = planted(4, 7);
  assert.deepEqual(shape(cluster(nodes, edges)), shape(cluster(nodes, edges)));
});

check("a duplicated edge changes nothing structural", () => {
  // Parallel relationships between the same pair collapse to one weight.
  const { nodes, edges } = planted(3, 6);
  const doubled = [...edges, ...edges.filter((e) => e.from === "c0n0")];
  assert.equal(cluster(nodes, doubled).clusters.length, cluster(nodes, edges).clusters.length);
});

// ── It finds the communities that are there ──────────────────────────────────

section("planted communities");

check("two cliques joined by one bridge come out as two clusters", () => {
  const a = ["a1", "a2", "a3", "a4"];
  const b = ["b1", "b2", "b3", "b4"];
  const nodes = [...a, ...b].map((id) => ({ id }));
  const edges = [...clique(a), ...clique(b), { from: "a1", to: "b1" }];
  const result = cluster(nodes, edges);
  assert.equal(result.clusters.length, 2, JSON.stringify(shape(result)));
  assert.equal(result.of.get("a1"), result.of.get("a4"));
  assert.notEqual(result.of.get("a1"), result.of.get("b1"));
});

check("five chained cliques come out as five clusters", () => {
  const { nodes, edges } = planted(5, 6);
  const result = cluster(nodes, edges);
  assert.equal(result.clusters.length, 5, JSON.stringify(shape(result)));
  assert.deepEqual(
    result.clusters.map((c) => c.length),
    [6, 6, 6, 6, 6],
  );
});

check("a higher resolution never merges what a lower one separated", () => {
  const { nodes, edges } = planted(5, 6);
  const coarse = clusterAt(nodes, edges, 1).clusters.length;
  const fine = clusterAt(nodes, edges, 2.5).clusters.length;
  assert.ok(fine >= coarse, `${fine} < ${coarse}`);
});

// ── Degenerate input ─────────────────────────────────────────────────────────

section("graphs that are barely graphs");

check("no nodes", () => {
  const result = cluster([], []);
  assert.deepEqual(result.clusters, []);
  assert.equal(result.of.size, 0);
});

check("nodes with no edges each get their own cluster", () => {
  const nodes = ["x", "y", "z"].map((id) => ({ id }));
  const result = cluster(nodes, []);
  assert.equal(result.clusters.length, 3);
  assert.deepEqual(shape(result), ["x", "y", "z"]);
});

check("an edge pointing outside the node set is ignored, not fatal", () => {
  // fullGraph caps the node list, so an edge can name a node that was cut.
  const nodes = [{ id: "a" }, { id: "b" }];
  const result = cluster(nodes, [
    { from: "a", to: "b" },
    { from: "b", to: "gone" },
    { from: "a", to: "a" },
  ]);
  assert.equal(result.of.size, 2);
  assert.equal(result.of.get("a"), result.of.get("b"));
});

// ── The contract the canvas relies on ────────────────────────────────────────

section("the output contract");

check("every node appears exactly once, and `of` agrees with `clusters`", () => {
  const { nodes, edges } = planted(4, 5);
  const result = cluster(nodes, edges);
  const flat = result.clusters.flat();
  assert.equal(flat.length, nodes.length);
  assert.equal(new Set(flat).size, nodes.length);
  result.clusters.forEach((members, i) => {
    for (const id of members) assert.equal(result.of.get(id), i, `${id} disagrees`);
  });
});

check("clusters are ordered largest first, ties by smallest member", () => {
  const big = ["m1", "m2", "m3", "m4", "m5"];
  const nodes = [...big, "b1", "b2", "a1", "a2"].map((id) => ({ id }));
  const edges = [
    ...clique(big),
    { from: "b1", to: "b2" },
    { from: "a1", to: "a2" },
  ];
  const result = cluster(nodes, edges);
  const sizes = result.clusters.map((c) => c.length);
  assert.deepEqual(
    [...sizes].sort((x, y) => y - x),
    sizes,
    "not ordered by size",
  );
  // Two clusters of two: the one holding a1 sorts ahead of the one holding b1.
  assert.ok(result.of.get("a1") < result.of.get("b1"), "tie not broken by member id");
});

check("members within a cluster are sorted", () => {
  const { nodes, edges } = planted(3, 6);
  for (const members of cluster(nodes, edges).clusters) {
    assert.deepEqual(members, [...members].sort(), "members out of order");
  }
});

// ── Resolution escalation ────────────────────────────────────────────────────

section("escalation when the answer is one blob");

check("a small graph is never re-cut, even when one cluster dominates", () => {
  // Nine nodes in one clique plus a straggler: the big cluster is 90% of the
  // graph and that is simply the truth about this graph.
  const ids = Array.from({ length: 9 }, (_, i) => `n${i}`);
  const nodes = [...ids, "lonely"].map((id) => ({ id }));
  const result = cluster(nodes, clique(ids));
  assert.equal(result.resolution, 1, "a small graph should not escalate");
});

check("a returned blob means even the finest resolution could not split it", () => {
  // The honest form of this assertion. Whether any particular graph escalates
  // depends on the graph; what must always hold is that `cluster` does not
  // hand back a blob it had a way to avoid.
  const dense = Array.from({ length: 60 }, (_, i) => `d${i}`);
  const nodes = dense.map((id) => ({ id }));
  const result = cluster(nodes, clique(dense));
  if (result.clusters[0].length > nodes.length * 0.6) {
    const finest = clusterAt(nodes, clique(dense), 1.8);
    assert.ok(
      finest.clusters[0].length > nodes.length * 0.6,
      "escalation was available and was not taken",
    );
  }
});

check("a large graph with real structure keeps the base resolution", () => {
  const { nodes, edges } = planted(8, 7);
  const result = cluster(nodes, edges);
  assert.equal(result.resolution, 1);
  assert.equal(result.clusters.length, 8, JSON.stringify(shape(result)));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
