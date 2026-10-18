"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import cytoscape from "cytoscape";
import fcose from "cytoscape-fcose";
import {
  cluster,
  describeClusters,
  type Clustering,
} from "@/lib/clusters";
import { UNDIRECTED, type RelType } from "@/lib/rel-types";
import { themeColors, watchTheme, isDarkTheme } from "@/lib/theme-colors";
import styles from "./full-graph.module.css";

cytoscape.use(fcose);

interface Node {
  id: string;
  name: string;
  topics: string[];
  degree: number;
  tracked: boolean;
  flagged: boolean;
}

interface Link {
  from: string;
  to: string;
  type: RelType;
}

interface Data {
  nodes: Node[];
  edges: Link[];
  truncated: boolean;
  total: number;
}

/**
 * Deterministic 32-bit hash of a string.
 *
 * Used to scatter a cluster's members around its centre. fcose with
 * `randomize: false` settles from wherever the nodes start, so seeding from
 * the id means the same graph lays out identically on every reload and on
 * every machine. Without it the layout reshuffles on each visit and the
 * picture becomes unreadable: spatial memory is most of what makes a graph
 * view better than a list, and it only exists if the shape holds still.
 */
function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
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
/** Clusters past this are drawn in muted grey rather than an 11th near-hue. */
const PALETTE = 10;

function clusterColor(index: number, dark: boolean, muted: string): string {
  if (index >= PALETTE) return muted;
  const usable = 360 - ACCENT_GUARD * 2;
  const hue = Math.round(((index * usable) / PALETTE + ACCENT_HUE + ACCENT_GUARD) % 360);
  return dark ? `hsl(${hue}, 55%, 64%)` : `hsl(${hue}, 58%, 36%)`;
}

/**
 * Starting positions: one cluster per neighbourhood, laid out apart.
 *
 * Centres go on a golden-angle spiral, which spreads any number of clusters
 * evenly without the ring-of-k look and without anything to tune. Members
 * scatter around their own centre by id hash, inside a radius that grows with
 * the cluster, so a big cluster does not start as a pile.
 *
 * This is only the starting draft. What keeps the clusters apart after fcose
 * has finished is the per-edge spring lengths below; seeding is what stops it
 * having to find the arrangement from a standing start, which on a graph this
 * connected it does not reliably do.
 */
function seedPositions(nodes: Node[], clustering: Clustering): Map<string, { x: number; y: number }> {
  const k = Math.max(1, clustering.clusters.length);
  const spread = 300 * Math.sqrt(k);
  const positions = new Map<string, { x: number; y: number }>();

  clustering.clusters.forEach((members, i) => {
    const angle = i * 2.39996; // golden angle, in radians
    const radius = spread * Math.sqrt((i + 0.5) / k);
    const cx = Math.cos(angle) * radius;
    const cy = Math.sin(angle) * radius;
    const local = 40 + 22 * Math.sqrt(members.length);

    for (const id of members) {
      const h = hash(id);
      const a = ((h % 10000) / 10000) * Math.PI * 2;
      // sqrt keeps the scatter uniform over the disc instead of bunched in
      // the middle.
      const r = Math.sqrt(((h >>> 16) % 10000) / 10000) * local;
      positions.set(id, { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
  });

  for (const n of nodes) if (!positions.has(n.id)) positions.set(n.id, { x: 0, y: 0 });
  return positions;
}

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function FullGraph() {
  const container = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const router = useRouter();

  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<Node | null>(null);
  const [zoomedIn, setZoomedIn] = useState(false);
  const [forceLabels, setForceLabels] = useState(false);
  /** Pinned by clicking a legend row; survives until cleared. */
  const [isolated, setIsolated] = useState<number | null>(null);
  /** Transient, from hovering a legend row. */
  const [preview, setPreview] = useState<number | null>(null);

  // The canvas resolves its palette at mount; the legend has to resolve the
  // same one at render, or its swatches disagree with the dots they explain.
  const isDark = useSyncExternalStore(watchTheme, isDarkTheme, () => false);

  // ── Fetch after mount, so the page shell paints first ────────────────────
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/graph", { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 401 ? "Your session expired." : "Could not load the graph.");
        return r.json();
      })
      .then(setData)
      .catch((err: Error) => {
        if (err.name !== "AbortError") setError(err.message);
      });
    return () => controller.abort();
  }, []);

  // ── Clusters ─────────────────────────────────────────────────────────────
  //
  // In the browser, not on the server: 211 concepts takes about eight
  // milliseconds, and a server-side cache of something that cheap is a
  // staleness bug with extra steps.
  const clustering = useMemo(
    () => (data ? cluster(data.nodes, data.edges) : null),
    [data],
  );

  const clusters = useMemo(
    () => (data && clustering ? describeClusters(data.nodes, clustering) : []),
    [data, clustering],
  );

  const active = preview ?? isolated;
  // Read inside build(), which is an effect: a theme switch rebuilds the
  // whole instance and has to put the isolation back where it was.
  const activeRef = useRef<number | null>(null);

  /** Dim everything outside one cluster, or restore everything. */
  const applyIsolation = useCallback((cy: cytoscape.Core, index: number | null) => {
    cy.batch(() => {
      cy.elements().removeClass("away");
      if (index === null) return;
      const inside = cy.nodes().filter((n) => n.data("cluster") === index);
      cy.elements().difference(inside.union(inside.edgesWith(inside))).addClass("away");
    });
  }, []);

  useEffect(() => {
    activeRef.current = active;
    const cy = cyRef.current;
    if (cy) applyIsolation(cy, active);
  }, [active, applyIsolation]);

  // Pinning a cluster also goes there, and clearing comes back out. Only on
  // a pin: a hover must never move the camera, or the legend becomes
  // impossible to read down.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const duration = prefersReducedMotion() ? 0 : 260;
    if (isolated === null) {
      cy.animate({ fit: { eles: cy.elements(), padding: 60 } }, { duration });
      return;
    }
    const inside = cy.nodes().filter((n) => n.data("cluster") === isolated);
    if (inside.nonempty()) {
      cy.animate({ fit: { eles: inside, padding: 80 } }, { duration });
    }
  }, [isolated]);

  // Escape clears a pinned isolation, which is the one interaction people try
  // without being told.
  useEffect(() => {
    if (isolated === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsolated(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isolated]);

  // ── Render ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = container.current;
    if (!el || !data || !clustering || data.nodes.length === 0) return;

    // Fit explicitly rather than trusting the layout's own `fit`, which did
    // not take at mount: the graph opened at zoom 1 on the origin, showing a
    // tenth of a picture that had been laid out correctly. Guarded on a
    // measurable container, because fitting to a zero-sized box is how you
    // get a NaN zoom, and remembered so a later resize does not yank the
    // view back from wherever the reader panned it.
    let fitted = false;
    const fitTo = (cy: cytoscape.Core) => {
      if (el.clientWidth <= 0 || el.clientHeight <= 0) return false;
      cy.fit(undefined, el.clientWidth < 640 ? 20 : 60);
      return true;
    };

    const build = () => {
      const colors = themeColors(el);
      const dark = colors.isDark;
      // Cytoscape cannot resolve a CSS custom property: passing one makes it
      // reject the whole declaration ("invalid style property") and fall back
      // to its own default face, which is not the UI font. Resolve it here.
      const sans =
        getComputedStyle(el).getPropertyValue("--sans").trim() || "sans-serif";
      const big = data.nodes.length > 400;
      const positions = seedPositions(data.nodes, clustering);
      const clusterOf = clustering.of;
      const anchors = new Set(clusters.map((c) => c.anchorId));

      // Parallel relationships between the same pair: two concepts linked by
      // both PREREQUISITE_OF and RELATED_TO get a slightly heavier line.
      const pairWeight = new Map<string, number>();
      const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
      for (const e of data.edges) {
        const key = pairKey(e.from, e.to);
        pairWeight.set(key, (pairWeight.get(key) ?? 0) + 1);
      }

      const cy = cytoscape({
        container: el,
        elements: [
          ...data.nodes.map((n) => {
            const index = clusterOf.get(n.id) ?? 0;
            return {
              data: {
                id: n.id,
                label: n.name,
                cluster: index,
                color: clusterColor(index, dark, colors.muted),
                // Sized for a full-screen canvas.
                size: Math.min(42, 11 + Math.sqrt(n.degree) * 6),
                flagged: n.flagged,
                tracked: n.tracked,
                anchor: anchors.has(n.id),
              },
              position: positions.get(n.id) ?? { x: 0, y: 0 },
              classes: prefersReducedMotion() ? "" : "entering",
            };
          }),
          ...data.edges.map((e) => {
            const from = clusterOf.get(e.from);
            const to = clusterOf.get(e.to);
            const inter = from !== to;
            return {
              data: {
                id: `${e.from}->${e.to}->${e.type}`,
                source: e.from,
                target: e.to,
                inter,
                directed: !UNDIRECTED.has(e.type),
                // Inside a cluster the edge takes the cluster's colour, so a
                // neighbourhood reads as one piece of fabric. Between
                // clusters it stays the quiet line colour, so the bridges
                // read as bridges.
                color: inter
                  ? colors.line
                  : clusterColor(from ?? 0, dark, colors.muted),
                opacity: inter ? 0.45 : dark ? 0.4 : 0.5,
                width: Math.min(2.2, 1 + ((pairWeight.get(pairKey(e.from, e.to)) ?? 1) - 1) * 0.4),
              },
            };
          }),
        ],
        style: [
          {
            selector: "node",
            style: {
              "background-color": "data(color)",
              width: "data(size)",
              height: "data(size)",
              "border-width": 1.5,
              "border-color": colors.bg,
              label: "data(label)",
              "font-size": 11,
              "font-family": sans,
              color: colors.fg,
              "text-valign": "bottom",
              "text-margin-y": 4,
              "text-wrap": "ellipsis",
              "text-max-width": "90px",
              "text-background-color": colors.bg,
              "text-background-opacity": 0.8,
              "text-background-padding": "2px",
              // Hidden by default: 211 labels at once is an unreadable smear
              // and costs a repaint every frame.
              "text-opacity": 0,
              "transition-property": "opacity",
              "transition-duration": 260,
            },
          },
          // The landmark of each cluster keeps its name at every zoom. A map
          // with no place names is a texture.
          {
            selector: "node[?anchor]",
            style: {
              "text-opacity": 1,
              "font-size": 12,
              "font-weight": 600,
              "text-background-opacity": 0.92,
              "z-index": 15,
            },
          },
          { selector: "node[?tracked]", style: { "border-color": colors.accent, "border-width": 2 } },
          { selector: "node[?flagged]", style: { "background-color": colors.danger } },
          {
            selector: "edge",
            style: {
              width: (edge: cytoscape.EdgeSingular) => Number(edge.data("width")),
              "line-color": "data(color)",
              "curve-style": big ? "haystack" : "bezier",
              opacity: (edge: cytoscape.EdgeSingular) => Number(edge.data("opacity")),
            },
          },
          { selector: ".labelled", style: { "text-opacity": 1, "z-index": 20 } },
          // Hovering dims everything that is not adjacent, which is the only
          // way to read one node's connections out of a dense graph.
          { selector: ".dim", style: { opacity: 0.1, "text-opacity": 0 } },
          // Isolating a cluster from the legend. Separate from .dim so a
          // hover inside an isolated cluster still works normally.
          { selector: ".away", style: { opacity: 0.08, "text-opacity": 0 } },
          {
            selector: ".highlight",
            style: {
              "line-color": colors.accent,
              width: 2,
              opacity: 1,
              "z-index": 10,
            },
          },
          // Arrowheads only while highlighted. 519 of them permanently on
          // screen is clutter; on the one node you are pointing at they
          // answer "which way does this go".
          {
            selector: ".highlight[?directed]",
            style: {
              "target-arrow-shape": "triangle",
              "target-arrow-color": colors.accent,
              "arrow-scale": 0.7,
            },
          },
          {
            selector: ".focus",
            style: {
              "border-color": colors.accent,
              "border-width": 3,
              "text-opacity": 1,
              "z-index": 30,
              // The closest thing this renderer has to a drop shadow.
              "underlay-color": colors.accent,
              "underlay-opacity": 0.18,
              "underlay-padding": 10,
            },
          },
          { selector: ".entering", style: { opacity: 0 } },
        ],
        layout: {
          name: "fcose",
          // The whole point: no random seeding, so the result is stable.
          randomize: false,
          animate: false,
          quality: big ? "default" : "proof",
          // Springs that know whether they are inside a cluster or between
          // two. This, more than the seeding, is what holds the
          // neighbourhoods apart once the simulation settles: short and stiff
          // within a community, long and slack across one.
          idealEdgeLength: (edge: cytoscape.EdgeSingular) => (edge.data("inter") ? 320 : 55),
          edgeElasticity: (edge: cytoscape.EdgeSingular) => (edge.data("inter") ? 0.05 : 0.45),
          nodeRepulsion: 12000,
          nodeSeparation: 140,
          // Low, or every cluster is dragged back towards one blob in the
          // middle and the separation above is wasted.
          gravity: 0.15,
          gravityRange: 4,
          // Two isolated concepts landed 20px apart and their labels merged
          // into one unreadable word. The first option makes the layout
          // reserve space for the label rather than the dot, which is what
          // actually collides; the others tile disconnected nodes on a padded
          // grid instead of heaping them.
          nodeDimensionsIncludeLabels: true,
          tile: true,
          tilingPaddingVertical: 30,
          tilingPaddingHorizontal: 30,
          padding: 40,
          // fcose accepts a function for the two spring options above, which
          // its type definitions declare as numbers.
        } as unknown as cytoscape.LayoutOptions,
        minZoom: 0.05,
        maxZoom: 3,
        // Performance switches. Without these a thousand nodes is unusable
        // on a trackpad: every pan repaints every edge and every label.
        hideEdgesOnViewport: big,
        textureOnViewport: big,
        motionBlur: false,
        pixelRatio: big ? 1 : undefined,
        wheelSensitivity: 0.2,
      });

      cyRef.current = cy;

      // Fit explicitly rather than trusting the layout's own `fit`, which did
      // not take at mount: the graph opened at zoom 1 centred on the origin,
      // showing a tenth of a picture that was laid out correctly. Guarded on
      // a measurable container, because fitting to a zero-sized box is how
      // you get a NaN zoom.
      fitted = fitTo(cy);

      // Labels appear once you are zoomed in far enough to read them. The
      // nine landmarks are always on, and are scaled against the zoom so
      // they stay the same size on screen however far out you are: at the
      // zoom that fits 211 nodes, 12 model pixels is five real ones.
      const syncLabels = () => {
        const zoom = cy.zoom();
        setZoomedIn(zoom > 0.75);
        cy.nodes("[?anchor]").style({
          "font-size": Math.max(11, Math.min(32, 12 / zoom)),
          "text-max-width": `${Math.round(Math.max(90, 110 / zoom))}px`,
        });
      };
      cy.on("zoom", syncLabels);
      syncLabels();

      cy.on("mouseover", "node", (event) => {
        const node = event.target;
        const near = node.closedNeighborhood();
        cy.elements().difference(near).addClass("dim");
        near.edges().addClass("highlight");
        node.addClass("focus");
        el.style.cursor = "pointer";
        setHovered(data.nodes.find((n) => n.id === node.id()) ?? null);
      });

      cy.on("mouseout", "node", () => {
        cy.elements().removeClass("dim highlight focus");
        el.style.cursor = "default";
        setHovered(null);
      });

      cy.on("tap", "node", (event) => router.push(`/c/${event.target.id()}`));
      // Tapping the backdrop is the other thing people try to get out of an
      // isolated cluster.
      cy.on("tap", (event) => {
        if (event.target === cy) setIsolated(null);
      });

      // Fade the nodes in once they have somewhere to be. The layout is
      // synchronous, so this runs after it has finished.
      if (!prefersReducedMotion()) {
        requestAnimationFrame(() => cy.nodes().removeClass("entering"));
      }

      applyIsolation(cy, activeRef.current);

      return cy;
    };

    let cy = build();

    // Cytoscape resolves the palette once and cannot see a custom property
    // change, so a theme switch would leave the graph in the old colours
    // until something remounted it. Rebuilding is heavy-handed but correct,
    // and a theme switch is a rare, deliberate act.
    const stopWatching = watchTheme(() => {
      const zoom = cy.zoom();
      const pan = cy.pan();
      cy.destroy();
      cy = build();
      cy.zoom(zoom);
      cy.pan(pan);
    });

    // The first measurable size also fits, in case the container had none
    // when the layout ran. After that a resize keeps whatever you were
    // looking at in the middle, instead of refitting: the view is wherever
    // you panned it, and yanking it back is rude. Cytoscape's own resize
    // keeps the top-left corner fixed rather than the centre, which on a
    // phone rotating to landscape leaves the graph mostly off screen.
    const observer = new ResizeObserver(() => {
      const zoom = cy.zoom();
      const pan = cy.pan();
      const centre = {
        x: (cy.width() / 2 - pan.x) / zoom,
        y: (cy.height() / 2 - pan.y) / zoom,
      };
      cy.resize();
      if (!fitted) {
        fitted = fitTo(cy);
        return;
      }
      cy.pan({
        x: cy.width() / 2 - centre.x * zoom,
        y: cy.height() / 2 - centre.y * zoom,
      });
    });
    observer.observe(el);

    return () => {
      stopWatching();
      observer.disconnect();
      cy.destroy();
      cyRef.current = null;
    };
  }, [data, clustering, clusters, router, applyIsolation]);

  // Labels: on past a zoom threshold, or forced from the control.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    if (zoomedIn || forceLabels) cy.nodes().addClass("labelled");
    else cy.nodes().removeClass("labelled");
  }, [zoomedIn, forceLabels, data, clustering]);

  if (error) {
    return <div className={styles.state}>{error}</div>;
  }

  if (!data) {
    return (
      <div className={styles.skeleton} aria-busy="true" aria-label="Loading the graph">
        <span className={styles.skeletonText}>Reading the graph…</span>
      </div>
    );
  }

  if (data.nodes.length === 0) {
    return (
      <div className={styles.state}>
        Nothing to draw yet. Add some concepts from a Claude conversation first.
      </div>
    );
  }

  const shown = clusters.slice(0, PALETTE);
  const rest = clusters.slice(PALETTE);
  const labelsOn = zoomedIn || forceLabels;

  // Every piece of chrome is overlaid on the canvas rather than stacked
  // around it, so none of it takes height away from the thing you came to
  // look at.
  return (
    <div className={styles.frame}>
      <div ref={container} className={styles.canvas} />

      {shown.length > 0 && (
        <div className={styles.legend}>
          <ul className={styles.legendList}>
            {shown.map((c) => (
              <li
                key={c.index}
                className={`${styles.legendRow} ${
                  isolated === c.index ? styles.legendRowOn : ""
                }`}
              >
                <button
                  type="button"
                  className={`${styles.legendItem} ${isolated === c.index ? styles.legendOn : ""}`}
                  aria-pressed={isolated === c.index}
                  onClick={() => setIsolated(isolated === c.index ? null : c.index)}
                  onMouseEnter={() => setPreview(c.index)}
                  onMouseLeave={() => setPreview((p) => (p === c.index ? null : p))}
                  onFocus={() => setPreview(c.index)}
                  onBlur={() => setPreview((p) => (p === c.index ? null : p))}
                >
                  <span
                    className={styles.swatch}
                    style={{ background: clusterColor(c.index, isDark, "var(--muted)") }}
                    aria-hidden="true"
                  />
                  <span className={styles.legendText}>
                    <span className={styles.legendName}>{c.topic ?? c.name}</span>
                    <span className={styles.legendSub}>{c.name}</span>
                  </span>
                  <span className={styles.legendCount}>{c.size}</span>
                </button>
                <Link
                  href={`/c/${c.anchorId}/read?mode=cluster`}
                  className={styles.legendRead}
                  title={`Read all ${c.size} notes in this cluster`}
                  onMouseEnter={() => setPreview(c.index)}
                  onMouseLeave={() => setPreview((p) => (p === c.index ? null : p))}
                  onFocus={() => setPreview(c.index)}
                  onBlur={() => setPreview((p) => (p === c.index ? null : p))}
                >
                  read
                </Link>
              </li>
            ))}
          </ul>
          {rest.length > 0 && (
            <p className={styles.legendRest}>
              +{rest.length} smaller {rest.length === 1 ? "cluster" : "clusters"}
            </p>
          )}
        </div>
      )}

      <div className={styles.controls}>
        <button
          type="button"
          className={styles.control}
          aria-pressed={forceLabels}
          onClick={() => setForceLabels((on) => !on)}
        >
          Names
        </button>
        <button
          type="button"
          className={styles.control}
          onClick={() => cyRef.current?.fit(undefined, 60)}
        >
          Fit
        </button>
      </div>

      <div className={styles.hud}>
        {hovered ? (
          <>
            <strong className={styles.hudName}>{hovered.name}</strong>
            <span className={styles.hudMeta}>
              {hovered.topics.slice(0, 3).join(" · ") || "no topic"} · {hovered.degree}{" "}
              {hovered.degree === 1 ? "link" : "links"} · click to open
            </span>
          </>
        ) : (
          <>
            <span className={styles.hudMeta}>
              {data.nodes.length} concepts · {data.edges.length} links ·{" "}
              {clusters.length} {clusters.length === 1 ? "cluster" : "clusters"}
              {!labelsOn && " · zoom in for names"}
            </span>
            {isolated !== null && clusters[isolated] && (
              <span className={styles.hudMeta}>
                showing {clusters[isolated].topic ?? clusters[isolated].name} · escape to clear
              </span>
            )}
            {data.truncated && (
              <span className={styles.hudMeta}>
                the {data.nodes.length} most connected of {data.total}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
