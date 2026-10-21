/**
 * Community detection, by modularity (Louvain).
 *
 * The whole-graph view had no visible neighbourhoods, and the reason was the
 * data, not the layout. Nodes were coloured by `topics.sort()[0]`: with 95
 * topics over 211 concepts and two to four topics on almost every one, that
 * picks a tag by alphabet, and 95 hues are indistinguishable anyway. The one
 * topic broad enough to group things covered 128 of 211 concepts, so it
 * grouped nothing.
 *
 * Links are the honest grouping. This module finds the communities in them.
 *
 * NO IMPORTS, ON PURPOSE. Pure arithmetic over ids, which means a plain
 * `node` run can test it, the same reason `src/lib/markdown.ts` is shaped the
 * way it is. It also runs in the browser, which is where it is called: 211
 * nodes is well under a millisecond, and a server-side cache of something
 * this cheap is just a staleness bug waiting to be written.
 *
 * DETERMINISM IS THE CONTRACT. The canvas seeds its layout from the result,
 * and the whole reason that layout is seeded is so the graph looks the same
 * on every reload and every machine. A clustering that reshuffled on each
 * call would throw that away without producing a single error. Every place
 * an iteration order could leak in is therefore pinned: ids are sorted before
 * anything is indexed, nodes are swept in that order, candidate communities
 * are visited in ascending index order, a move is taken only on a strict
 * improvement, and the final numbering is by size and then by smallest
 * member. Nothing here reads a clock, a hash seed, or a Map insertion order
 * that was not built in sorted order first.
 */

export interface ClusterNodeInput {
  id: string;
}

export interface ClusterEdgeInput {
  from: string;
  to: string;
}

export interface Clustering {
  /** Cluster index per node id. 0 is the largest cluster. */
  of: Map<string, number>;
  /** Member ids per cluster, each sorted. Clusters ordered largest first. */
  clusters: string[][];
  /** The resolution that produced this, after any escalation. */
  resolution: number;
}

/** Below this, a modularity gain is floating-point noise, not an improvement. */
const EPSILON = 1e-9;

/** Sweeps per level, and levels. Both are reached only by pathological input. */
const MAX_SWEEPS = 24;
const MAX_LEVELS = 12;

/**
 * Resolutions tried in order. Higher means smaller, tighter communities.
 *
 * One knob decides whether this view shows anything, so it is not left at a
 * guess: if the first answer is one big blob the graph is re-cut finer. The
 * escalation rule is fixed, so the result stays a pure function of the input.
 */
const RESOLUTIONS = [1, 1.4, 1.8];

/** A cluster holding more of the graph than this is not a grouping. */
const BLOB_SHARE = 0.6;

/**
 * Small graphs are exempt from escalation. Four concepts in two pairs is two
 * clusters and one of them is half the graph; that is the right answer, not a
 * blob, and re-cutting it finer would shatter a correct result.
 */
const ESCALATE_ABOVE = 40;

/**
 * Cluster, escalating the resolution if the result is one blob.
 *
 * The returned clustering satisfies: either the largest cluster is under
 * `BLOB_SHARE` of the graph, or the finest resolution could not do better.
 */
export function cluster(
  nodes: ReadonlyArray<ClusterNodeInput>,
  edges: ReadonlyArray<ClusterEdgeInput>,
): Clustering {
  let last = clusterAt(nodes, edges, RESOLUTIONS[0]);
  if (nodes.length <= ESCALATE_ABOVE) return last;

  for (let i = 1; i < RESOLUTIONS.length; i++) {
    if (!isBlob(last, nodes.length)) return last;
    last = clusterAt(nodes, edges, RESOLUTIONS[i]);
  }
  return last;
}

function isBlob(result: Clustering, total: number): boolean {
  if (total === 0 || result.clusters.length === 0) return false;
  return result.clusters[0].length > total * BLOB_SHARE;
}

/**
 * Cluster at one fixed resolution.
 *
 * Exported so the behaviour of the escalation above can be asserted against
 * the thing it escalates, rather than against a guess about what a particular
 * graph ought to come out as.
 */
export function clusterAt(
  nodes: ReadonlyArray<ClusterNodeInput>,
  edges: ReadonlyArray<ClusterEdgeInput>,
  resolution: number,
): Clustering {
  // Sorted first, so the index a node gets depends on the node set and not on
  // the order the database happened to return it in.
  const ids = [...new Set(nodes.map((n) => n.id))].sort();
  const index = new Map<string, number>();
  ids.forEach((id, i) => index.set(id, i));

  const n = ids.length;
  if (n === 0) return { of: new Map(), clusters: [], resolution };

  // Parallel edges collapse to one weighted edge. Two concepts linked by both
  // PREREQUISITE_OF and RELATED_TO are more tied together than two linked
  // once, and Louvain is weighted anyway, so the weight is the count.
  const weights = new Map<number, number>();
  for (const e of edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    // An edge to a node outside the set is not an error: `fullGraph` caps the
    // node list, so an edge can point at something that was cut.
    if (a === undefined || b === undefined || a === b) continue;
    const key = a < b ? a * n + b : b * n + a;
    weights.set(key, (weights.get(key) ?? 0) + 1);
  }

  const adj: Array<Array<{ to: number; w: number }>> = Array.from({ length: n }, () => []);
  for (const [key, w] of weights) {
    const a = Math.floor(key / n);
    const b = key % n;
    adj[a].push({ to: b, w });
    adj[b].push({ to: a, w });
  }
  // The map was keyed by a number, so its iteration order is insertion order,
  // which came from the caller's edge order. Sorting restores independence.
  for (const list of adj) list.sort((x, y) => x.to - y.to);

  const membership = louvain(n, adj, resolution);
  return finalise(ids, membership, resolution);
}

/**
 * Louvain proper: move nodes greedily, aggregate each community into a node,
 * repeat until a pass changes nothing.
 *
 * Label propagation would be a third of the code and was rejected for a
 * reason visible in this graph: it collapses to one community in the presence
 * of a high-degree hub, and the busiest concept here has 30 links.
 */
function louvain(
  n: number,
  adj: Array<Array<{ to: number; w: number }>>,
  resolution: number,
): number[] {
  // Where each ORIGINAL node currently lives, as an index into the level graph.
  let mapping = Array.from({ length: n }, (_, i) => i);

  let size = n;
  let levelAdj = adj;
  let selfLoop = new Array<number>(n).fill(0);

  for (let level = 0; level < MAX_LEVELS; level++) {
    const community = localMoving(size, levelAdj, selfLoop, resolution);
    const { renumbered, count } = renumber(community);
    // Nothing merged, so no further level can merge anything either.
    if (count === size) break;

    mapping = mapping.map((c) => renumbered[c]);
    const next = aggregate(size, levelAdj, selfLoop, renumbered, count);
    size = count;
    levelAdj = next.adj;
    selfLoop = next.selfLoop;
  }

  return mapping;
}

/**
 * One level: sweep the nodes, moving each into the neighbouring community
 * that gains the most modularity, until a whole sweep moves nobody.
 *
 * Only a STRICT improvement counts as a move. Accepting an equal-gain move
 * would let two nodes trade places forever, and the sweep cap would then
 * decide the answer, which is a nondeterminism waiting for a graph shaped
 * just so.
 */
function localMoving(
  n: number,
  adj: Array<Array<{ to: number; w: number }>>,
  selfLoop: number[],
  resolution: number,
): number[] {
  const degree = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let sum = 2 * selfLoop[i];
    for (const { w } of adj[i]) sum += w;
    degree[i] = sum;
  }

  // 2m in the modularity formula: the sum of all degrees.
  const m2 = degree.reduce((a, b) => a + b, 0);
  const community = Array.from({ length: n }, (_, i) => i);
  // With no edges at all, every node is its own community and that is final.
  if (m2 === 0) return community;

  const total = [...degree];

  for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
    let moved = false;

    for (let i = 0; i < n; i++) {
      const home = community[i];
      const ki = degree[i];

      // Weight from i into each neighbouring community.
      const touched: number[] = [];
      const into = new Map<number, number>();
      for (const { to, w } of adj[i]) {
        const c = community[to];
        const seen = into.get(c);
        if (seen === undefined) {
          into.set(c, w);
          touched.push(c);
        } else {
          into.set(c, seen + w);
        }
      }

      // Take i out before scoring, or its own degree inflates the cost of
      // going back where it came from.
      total[home] -= ki;

      const stay = (into.get(home) ?? 0) - (resolution * total[home] * ki) / m2;
      let bestCommunity = home;
      let bestGain = stay;

      // Ascending, so an exact tie is broken by the lower index rather than
      // by whichever neighbour the adjacency list happened to list first.
      touched.sort((a, b) => a - b);
      for (const c of touched) {
        if (c === home) continue;
        const gain = (into.get(c) ?? 0) - (resolution * total[c] * ki) / m2;
        if (gain > bestGain + EPSILON) {
          bestGain = gain;
          bestCommunity = c;
        }
      }

      total[bestCommunity] += ki;
      if (bestCommunity !== home) {
        community[i] = bestCommunity;
        moved = true;
      }
    }

    if (!moved) break;
  }

  return community;
}

/** Compress community labels to 0..count-1, in order of first appearance. */
function renumber(community: number[]): { renumbered: number[]; count: number } {
  const seen = new Map<number, number>();
  const renumbered = community.map((c) => {
    const existing = seen.get(c);
    if (existing !== undefined) return existing;
    const next = seen.size;
    seen.set(c, next);
    return next;
  });
  return { renumbered, count: seen.size };
}

/** Collapse each community into a single node, carrying its internal weight. */
function aggregate(
  n: number,
  adj: Array<Array<{ to: number; w: number }>>,
  selfLoop: number[],
  community: number[],
  count: number,
): { adj: Array<Array<{ to: number; w: number }>>; selfLoop: number[] } {
  const nextSelf = new Array<number>(count).fill(0);
  const between = new Map<number, number>();

  for (let i = 0; i < n; i++) {
    const ci = community[i];
    nextSelf[ci] += selfLoop[i];
    for (const { to, w } of adj[i]) {
      const ct = community[to];
      if (ci === ct) {
        // Seen once from each end, so each internal edge is added twice.
        nextSelf[ci] += w / 2;
      } else {
        const key = ci * count + ct;
        between.set(key, (between.get(key) ?? 0) + w);
      }
    }
  }

  const nextAdj: Array<Array<{ to: number; w: number }>> = Array.from(
    { length: count },
    () => [],
  );
  for (const [key, w] of between) {
    nextAdj[Math.floor(key / count)].push({ to: key % count, w });
  }
  for (const list of nextAdj) list.sort((x, y) => x.to - y.to);

  return { adj: nextAdj, selfLoop: nextSelf };
}

/**
 * Number the clusters by size, largest first.
 *
 * Ties go to the cluster with the smallest member id. Size alone would leave
 * two clusters of eight to be ordered by whichever node Louvain touched
 * first, and cluster index picks the colour, so that would mean two colours
 * swapping between reloads on a graph that had not changed.
 */
function finalise(ids: string[], membership: number[], resolution: number): Clustering {
  const groups = new Map<number, string[]>();
  membership.forEach((c, i) => {
    const existing = groups.get(c);
    if (existing) existing.push(ids[i]);
    else groups.set(c, [ids[i]]);
  });

  // `ids` was sorted, so each group is already sorted.
  const clusters = [...groups.values()].sort(
    (a, b) => b.length - a.length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );

  const of = new Map<string, number>();
  clusters.forEach((members, i) => {
    for (const id of members) of.set(id, i);
  });

  return { of, clusters, resolution };
}

/** What naming a cluster needs to know about a node. */
export interface DescribeNodeInput {
  id: string;
  name: string;
  topics: string[];
  degree: number;
  /** A name a member gives the whole community, or null. */
  clusterName?: string | null;
}

export interface ClusterInfo {
  index: number;
  size: number;
  /** The highest-degree member: the cluster's landmark, and its name. */
  anchorId: string;
  name: string;
  /** The topic most over-represented here, or null if nothing stands out. */
  topic: string | null;
  /** A name someone typed, carried by a member, or null. */
  custom: string | null;
  /** What to call this cluster on screen: the typed name, else the topic, else the landmark. */
  label: string;
}

/**
 * Give each cluster a name and a topic.
 *
 * The name is its busiest member, because that is what you would point at to
 * say where you are. The topic is the one with the highest LIFT — its share
 * inside the cluster over its share of the whole graph — not the most common
 * one. Most common would answer `system-design` for six clusters out of nine,
 * since that tag is on 61% of the graph; lift answers `oauth`, `consistency`,
 * `dns`, which is the thing you wanted to know.
 *
 * Here rather than in the canvas because the reading page has to call a
 * cluster by the same name the legend does. Two descriptions of one grouping
 * is how the picture and the page start disagreeing about where you are.
 */
export function describeClusters(
  nodes: DescribeNodeInput[],
  clustering: Clustering,
): ClusterInfo[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const graphShare = new Map<string, number>();
  for (const n of nodes) {
    for (const t of n.topics) graphShare.set(t, (graphShare.get(t) ?? 0) + 1);
  }

  return clustering.clusters.map((members, index) => {
    const nodesIn = members.flatMap((id) => {
      const n = byId.get(id);
      return n ? [n] : [];
    });

    const anchor = nodesIn.reduce(
      (best: DescribeNodeInput | null, n) =>
        !best || n.degree > best.degree || (n.degree === best.degree && n.name < best.name)
          ? n
          : best,
      null,
    );

    const counts = new Map<string, number>();
    for (const n of nodesIn) {
      for (const t of n.topics) counts.set(t, (counts.get(t) ?? 0) + 1);
    }

    // At least two members, or a single note with a unique tag wins every
    // time and the label says nothing about the cluster.
    let topic: string | null = null;
    let bestLift = 0;
    for (const name of [...counts.keys()].sort()) {
      const count = counts.get(name)!;
      if (count < 2) continue;
      const lift = count / nodesIn.length / ((graphShare.get(name) ?? 1) / nodes.length);
      if (lift > bestLift) {
        bestLift = lift;
        topic = name;
      }
    }

    // A typed name beats everything derived. Read from whichever member is
    // carrying one — the busiest, when more than one somehow is, which keeps
    // the answer the same every load rather than depending on row order.
    const carrier = nodesIn.reduce(
      (best: DescribeNodeInput | null, n) =>
        !n.clusterName
          ? best
          : !best ||
              n.degree > best.degree ||
              (n.degree === best.degree && n.name < best.name)
            ? n
            : best,
      null,
    );
    const custom = carrier?.clusterName ?? null;
    const name = anchor?.name ?? "";

    return {
      index,
      size: members.length,
      anchorId: anchor?.id ?? members[0] ?? "",
      name,
      topic,
      custom,
      label: custom ?? topic ?? name,
    };
  });
}

/**
 * A hue per cluster.
 *
 * Colour used to come from the node's alphabetically-first topic, which on
 * this graph meant colouring by alphabet: almost every concept carries two to
 * four topics, there are 95 of them, and the one broad enough to group things
 * covered 128 of 211 concepts. Clusters are the honest grouping and there are
 * usually under a dozen, which is a number of colours a person can actually
 * hold apart.
 *
 * ACCENT_HUE is skipped because the accent is also the "tracked" ring. A
 * cluster drawn in the same green made tracked and untracked nodes of that
 * cluster impossible to tell apart.
 *
 * COMMAS ARE REQUIRED. Cytoscape's colour parser predates the space-separated
 * `hsl(H S% L%)` syntax and silently falls back to grey on it, with no warning
 * and no error: every node rendered the same grey while the legend, which is
 * ordinary CSS and does understand the modern form, showed the right colours.
 */
const ACCENT_HUE = 152;
const ACCENT_GUARD = 20;
/** Clusters past this share the muted grey, which the legend admits to. */
export const PALETTE = 14;
/**
 * Coprime with PALETTE, so the slots are still each used exactly once and the
 * wheel is still covered evenly — but consecutive clusters, which sit on
 * adjacent legend rows, land on opposite sides of it instead of 23° apart.
 */
const HUE_STRIDE = 5;

export function clusterColor(index: number, dark: boolean, muted: string): string {
  if (index >= PALETTE) return muted;
  const slot = (index * HUE_STRIDE) % PALETTE;
  const usable = 360 - ACCENT_GUARD * 2;
  const hue = Math.round((slot * usable) / PALETTE + ACCENT_HUE + ACCENT_GUARD) % 360;
  // Fourteen flat hues do not hold apart. Alternating lightness gives
  // neighbours a second dimension to differ in, which is what makes the
  // wider palette legible rather than just wider.
  const dim = slot % 2 === 1;
  return dark
    ? `hsl(${hue}, 55%, ${dim ? 56 : 64}%)`
    : `hsl(${hue}, 58%, ${dim ? 44 : 36}%)`;
}
