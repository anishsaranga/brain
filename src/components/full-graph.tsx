"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import cytoscape from "cytoscape";
import fcose from "cytoscape-fcose";
import { themeColors, watchTheme } from "@/lib/theme-colors";
import styles from "./full-graph.module.css";

cytoscape.use(fcose);

interface Node {
  id: string;
  name: string;
  topic: string | null;
  degree: number;
  tracked: boolean;
  flagged: boolean;
}

interface Link {
  from: string;
  to: string;
  type: string;
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
 * Used to seed each node's starting position. fcose with `randomize: false`
 * settles from wherever the nodes start, so seeding from the id means the
 * same graph lays out identically on every reload and on every machine.
 * Without it the layout reshuffles on each visit and the picture becomes
 * unreadable: spatial memory is most of what makes a graph view better than
 * a list, and it only exists if the shape holds still.
 */
function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A stable colour per topic, so the same cluster is the same colour daily. */
const TOPIC_HUES = [152, 28, 210, 340, 52, 265, 190, 95, 12, 305];

function topicColor(topic: string | null, dark: boolean): string | null {
  if (!topic) return null;
  const hue = TOPIC_HUES[hash(topic) % TOPIC_HUES.length];
  return dark ? `hsl(${hue} 52% 62%)` : `hsl(${hue} 48% 42%)`;
}

export default function FullGraph() {
  const container = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const router = useRouter();

  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<Node | null>(null);
  const [showLabels, setShowLabels] = useState(false);

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

  const legend = useMemo(() => {
    if (!data) return [];
    const counts = new Map<string, number>();
    for (const n of data.nodes) {
      if (n.topic) counts.set(n.topic, (counts.get(n.topic) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [data]);

  // ── Render ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = container.current;
    if (!el || !data || data.nodes.length === 0) return;

    const build = () => {
      const colors = themeColors(el);
      const dark = colors.isDark;
      const big = data.nodes.length > 400;

      const cy = cytoscape({
        container: el,
        elements: [
          ...data.nodes.map((n) => ({
            data: {
              id: n.id,
              label: n.name,
              color: topicColor(n.topic, dark) ?? colors.muted,
              size: Math.min(34, 8 + Math.sqrt(n.degree) * 5),
              flagged: n.flagged,
              tracked: n.tracked,
            },
            // Seeded, so the layout is reproducible. Spread over a square
            // whose side grows with the node count, which keeps the starting
            // density roughly constant as the graph grows.
            position: (() => {
              const span = Math.max(600, Math.sqrt(data.nodes.length) * 70);
              const h = hash(n.id);
              return {
                x: ((h % 10000) / 10000) * span,
                y: (((h >>> 16) % 10000) / 10000) * span,
              };
            })(),
          })),
          ...data.edges.map((e) => ({
            data: { id: `${e.from}->${e.to}->${e.type}`, source: e.from, target: e.to },
          })),
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
              "font-size": 10,
              "font-family": "var(--font-sans), sans-serif",
              color: colors.fg,
              "text-valign": "bottom",
              "text-margin-y": 4,
              "text-wrap": "ellipsis",
              "text-max-width": "90px",
              "text-background-color": colors.bg,
              "text-background-opacity": 0.8,
              "text-background-padding": "2px",
              // Hidden by default on a large graph: hundreds of labels at
              // once is an unreadable smear and costs a repaint each frame.
              "text-opacity": 0,
            },
          },
          { selector: "node[?tracked]", style: { "border-color": colors.accent, "border-width": 2 } },
          { selector: "node[?flagged]", style: { "background-color": colors.danger } },
          {
            selector: "edge",
            style: {
              width: 1,
              "line-color": colors.line,
              "curve-style": big ? "haystack" : "bezier",
              opacity: 0.75,
            },
          },
          { selector: ".labelled", style: { "text-opacity": 1, "z-index": 20 } },
          // Hovering dims everything that is not adjacent, which is the only
          // way to read one node's connections out of a dense graph.
          { selector: ".dim", style: { opacity: 0.12, "text-opacity": 0 } },
          {
            selector: ".highlight",
            style: {
              "line-color": colors.accent,
              "target-arrow-color": colors.accent,
              width: 2,
              opacity: 1,
              "z-index": 10,
            },
          },
          {
            selector: ".focus",
            style: { "border-color": colors.accent, "border-width": 3, "text-opacity": 1, "z-index": 30 },
          },
        ],
        layout: {
          name: "fcose",
          // The whole point: no random seeding, so the result is stable.
          randomize: false,
          animate: false,
          quality: big ? "default" : "proof",
          nodeRepulsion: 9000,
          idealEdgeLength: 90,
          nodeSeparation: 90,
          padding: 40,
        } as cytoscape.LayoutOptions,
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

      // Labels appear once you are zoomed in far enough to read them.
      const syncLabels = () => {
        const on = cy.zoom() > 0.75;
        setShowLabels(on);
        if (on) cy.nodes().addClass("labelled");
        else cy.nodes().removeClass("labelled");
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

    const observer = new ResizeObserver(() => cy.resize());
    observer.observe(el);

    return () => {
      stopWatching();
      observer.disconnect();
      cy.destroy();
      cyRef.current = null;
    };
  }, [data, router]);

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

  return (
    <>
      <div className={styles.frame}>
        <div ref={container} className={styles.canvas} />

        <div className={styles.hud}>
          {hovered ? (
            <>
              <strong className={styles.hudName}>{hovered.name}</strong>
              <span className={styles.hudMeta}>
                {hovered.topic ?? "no topic"} · {hovered.degree}{" "}
                {hovered.degree === 1 ? "link" : "links"}
              </span>
            </>
          ) : (
            <span className={styles.hudMeta}>
              {data.nodes.length} concepts · {data.edges.length} links
              {!showLabels && " · zoom in for names"}
            </span>
          )}
        </div>

        <div className={styles.controls}>
          <button
            type="button"
            className={styles.control}
            onClick={() => cyRef.current?.fit(undefined, 40)}
          >
            Fit
          </button>
        </div>
      </div>

      {legend.length > 0 && (
        <ul className={styles.legend}>
          {legend.map(([topic, count]) => (
            <li key={topic} className={styles.legendItem}>
              <span
                className={styles.swatch}
                style={{ background: topicColor(topic, false) ?? undefined }}
                aria-hidden="true"
              />
              {topic}
              <span className={styles.legendCount}>{count}</span>
            </li>
          ))}
        </ul>
      )}

      {data.truncated && (
        <p className={styles.truncated}>
          Showing the {data.nodes.length} most connected of {data.total} concepts.
          The cap keeps the canvas usable; the rest are reachable by search.
        </p>
      )}
    </>
  );
}
