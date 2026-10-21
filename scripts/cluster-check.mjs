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

const { cluster, clusterAt, describeClusters, clusterColor, PALETTE } = await import(
  "@/lib/clusters"
);

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

section("describeClusters");

/** Two cliques: one tagged mostly `auth`, one mostly `dsa`, both tagged `notes`. */
function tagged() {
  const nodes = [
    { id: "a1", name: "OAuth", topics: ["auth", "notes"], degree: 9 },
    { id: "a2", name: "Tokens", topics: ["auth", "notes"], degree: 2 },
    { id: "a3", name: "Scopes", topics: ["auth", "notes"], degree: 2 },
    { id: "b1", name: "Graphs", topics: ["dsa", "notes"], degree: 3 },
    { id: "b2", name: "Trees", topics: ["dsa", "notes"], degree: 2 },
    { id: "b3", name: "Heaps", topics: ["dsa", "notes"], degree: 2 },
  ];
  const edges = [
    { from: "a1", to: "a2" },
    { from: "a2", to: "a3" },
    { from: "a3", to: "a1" },
    { from: "b1", to: "b2" },
    { from: "b2", to: "b3" },
    { from: "b3", to: "b1" },
  ];
  return { nodes, edges };
}

check("names a cluster after its busiest member", () => {
  const { nodes, edges } = tagged();
  const info = describeClusters(nodes, cluster(nodes, edges));
  const auth = info.find((c) => c.anchorId === "a1");
  assert.ok(auth, "the 9-degree node must anchor its own cluster");
  assert.equal(auth.name, "OAuth");
});

check("labels with the stand-out topic, not the common one", () => {
  const { nodes, edges } = tagged();
  const info = describeClusters(nodes, cluster(nodes, edges));
  assert.deepEqual(
    info.map((c) => c.topic).sort(),
    ["auth", "dsa"],
    "`notes` is on every node, so it distinguishes nothing and must never win",
  );
});

check("a topic held by one member is not a label", () => {
  const nodes = [
    { id: "a1", name: "One", topics: ["solo"], degree: 1 },
    { id: "a2", name: "Two", topics: [], degree: 1 },
  ];
  const info = describeClusters(nodes, cluster(nodes, [{ from: "a1", to: "a2" }]));
  assert.equal(info[0].topic, null, "one note with a unique tag says nothing about a group");
});

check("every cluster gets a description, in the same order", () => {
  const { nodes, edges } = tagged();
  const clustering = cluster(nodes, edges);
  const info = describeClusters(nodes, clustering);
  assert.equal(info.length, clustering.clusters.length);
  info.forEach((c, i) => {
    assert.equal(c.index, i);
    assert.equal(c.size, clustering.clusters[i].length);
    assert.ok(clustering.clusters[i].includes(c.anchorId));
  });
});

section("a typed name");

check("a name on a member beats the lift topic", () => {
  const { nodes, edges } = tagged();
  nodes.find((n) => n.id === "a2").clusterName = "Sign-in";
  const info = describeClusters(nodes, cluster(nodes, edges));
  const auth = info.find((c) => c.anchorId === "a1");
  assert.equal(auth.custom, "Sign-in");
  assert.equal(auth.label, "Sign-in");
  assert.equal(auth.topic, "auth", "the derived parts stay, they are just not what is shown");
});

check("the busiest carrier wins when two notes carry a name", () => {
  const { nodes, edges } = tagged();
  nodes.find((n) => n.id === "a1").clusterName = "Busy";
  nodes.find((n) => n.id === "a2").clusterName = "Quiet";
  const info = describeClusters(nodes, cluster(nodes, edges));
  assert.equal(info.find((c) => c.anchorId === "a1").label, "Busy");
});

check("a tie between carriers resolves by name, not by row order", () => {
  const base = () => [
    { id: "x1", name: "Alpha", topics: [], degree: 2, clusterName: "From Alpha" },
    { id: "x2", name: "Beta", topics: [], degree: 2, clusterName: "From Beta" },
    { id: "x3", name: "Gamma", topics: [], degree: 2 },
  ];
  const edges = [
    { from: "x1", to: "x2" },
    { from: "x2", to: "x3" },
    { from: "x3", to: "x1" },
  ];
  const forwards = describeClusters(base(), cluster(base(), edges))[0].label;
  const backwards = describeClusters(base().reverse(), cluster(base(), edges))[0].label;
  assert.equal(forwards, "From Alpha");
  assert.equal(backwards, forwards, "the same graph must describe itself the same way");
});

check("with no typed name the label is what it always was", () => {
  const { nodes, edges } = tagged();
  const info = describeClusters(nodes, cluster(nodes, edges));
  for (const c of info) {
    assert.equal(c.custom, null);
    assert.equal(c.label, c.topic ?? c.name);
  }
});

section("the palette");

check("every cluster below the cap gets its own colour", () => {
  const seen = new Set();
  for (let i = 0; i < PALETTE; i++) seen.add(clusterColor(i, true, "grey"));
  assert.equal(seen.size, PALETTE, "fourteen clusters, fourteen distinct colours");
});

check("past the cap they share the muted grey", () => {
  assert.equal(clusterColor(PALETTE, true, "grey"), "grey");
  assert.equal(clusterColor(PALETTE + 9, false, "grey"), "grey");
});

check("neighbouring clusters are far apart in hue", () => {
  const hueOf = (i) => Number(clusterColor(i, true, "grey").match(/hsl\((\d+)/)[1]);
  for (let i = 0; i + 1 < PALETTE; i++) {
    const a = hueOf(i);
    const b = hueOf(i + 1);
    const apart = Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
    assert.ok(
      apart > 90,
      `clusters ${i} and ${i + 1} sit on adjacent legend rows but are ${apart}° apart`,
    );
  }
});

check("nothing claims the accent, which is the tracked ring", () => {
  const hueOf = (i) => Number(clusterColor(i, true, "grey").match(/hsl\((\d+)/)[1]);
  for (let i = 0; i < PALETTE; i++) {
    const d = Math.min(Math.abs(hueOf(i) - 152), 360 - Math.abs(hueOf(i) - 152));
    assert.ok(d >= 20, `cluster ${i} is ${d}° from the accent green`);
  }
});

check("colours are comma-separated, which Cytoscape's parser requires", () => {
  for (let i = 0; i < PALETTE; i++) {
    assert.match(clusterColor(i, i % 2 === 0, "grey"), /^hsl\(\d+, \d+%, \d+%\)$/);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
