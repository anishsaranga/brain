"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import cytoscape from "cytoscape";
import { relLabel } from "@/lib/rel-types";
import { themeColors, watchTheme } from "@/lib/theme-colors";
import styles from "./graph-canvas.module.css";

export interface CanvasNode {
  id: string;
  name: string;
  tracked: boolean;
  flagged: boolean;
}

export interface CanvasEdge {
  from: string;
  to: string;
  type: string;
}

/**
 * Concentric rings by hop distance, computed here rather than by a force
 * layout.
 *
 * A force simulation was the obvious choice and the wrong one. Two problems,
 * both fatal for this use:
 *
 * 1. It is not stable. From random starting points the same subgraph settles
 *    somewhere different every time, so a concept moves whenever you reload
 *    and walking the graph means re-reading it at every step. Spatial memory
 *    is most of what makes a graph view better than a list.
 * 2. On small graphs it produced near-collinear results with overlapping
 *    labels — fcose's incremental mode barely separates four nodes.
 *
 * Placing nodes directly fixes both. The ring says how far a concept is from
 * the one you are looking at, which is the single most useful thing the
 * picture can encode, and positions are a pure function of the node set so
 * the same neighbourhood always draws identically, on any machine.
 */
function layoutPositions(
  centerId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  width: number,
  height: number,
): Map<string, { x: number; y: number }> {
  // Hop distance from the centre, over the edges we were actually given.
  const adjacency = new Map<string, Set<string>>();
  for (const n of nodes) adjacency.set(n.id, new Set());
  for (const e of edges) {
    adjacency.get(e.from)?.add(e.to);
    adjacency.get(e.to)?.add(e.from);
  }

  const hop = new Map<string, number>([[centerId, 0]]);
  let frontier = [centerId];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbour of adjacency.get(id) ?? []) {
        if (!hop.has(neighbour)) {
          hop.set(neighbour, (hop.get(id) ?? 0) + 1);
          next.push(neighbour);
        }
      }
    }
    frontier = next;
  }

  // Anything the edge set did not reach still has to go somewhere: the node
  // cap can include a concept whose connecting edge was cut.
  const maxHop = Math.max(1, ...[...hop.values()]);
  for (const n of nodes) if (!hop.has(n.id)) hop.set(n.id, maxHop + 1);

  const rings = new Map<number, string[]>();
  for (const n of nodes) {
    const d = hop.get(n.id) ?? 1;
    if (d === 0) continue;
    if (!rings.has(d)) rings.set(d, []);
    rings.get(d)!.push(n.id);
  }

  const deepest = Math.max(1, ...rings.keys());
  // Leave room for labels, which sit below each node.
  const usable = Math.min(width, height) / 2 - 46;
  const step = usable / deepest;

  const positions = new Map<string, { x: number; y: number }>([[centerId, { x: 0, y: 0 }]]);
  for (const [distance, ids] of rings) {
    // Sorted so the arrangement depends only on which concepts are present,
    // never on the order the database happened to return them in.
    ids.sort();
    const radius = step * distance;
    // Offset each ring so nodes do not line up spoke-on-spoke with the ring
    // inside it, and start at -90° so the first node sits at the top.
    const offset = distance * 0.37;
    ids.forEach((id, i) => {
      const angle = (i / ids.length) * Math.PI * 2 + offset - Math.PI / 2;
      positions.set(id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    });
  }
  return positions;
}


export default function GraphCanvas({
  centerId,
  nodes,
  edges,
  height = 460,
}: {
  centerId: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  height?: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    const el = container.current;
    if (!el) return;

    const build = () => {
    const colors = themeColors(el);
    const width = el.clientWidth || 800;
    const positions = layoutPositions(centerId, nodes, edges, width, height);

    const present = new Set(nodes.map((n) => n.id));

    const cy = cytoscape({
      container: el,
      elements: [
        ...nodes.map((n) => ({
          data: {
            id: n.id,
            label: n.name,
            center: n.id === centerId,
            flagged: n.flagged,
            tracked: n.tracked,
          },
          position: positions.get(n.id) ?? { x: 0, y: 0 },
        })),
        // Cytoscape drops an edge whose endpoints are not both present, which
        // is right: getNeighbourhood caps the node set, so an edge can point
        // outside it.
        ...edges
          .filter((e) => present.has(e.from) && present.has(e.to))
          .map((e) => ({
            data: {
              id: `${e.from}->${e.to}->${e.type}`,
              source: e.from,
              target: e.to,
              label: relLabel(e.type),
            },
          })),
      ],
      layout: { name: "preset", fit: true, padding: 30 },
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            "font-size": 11,
            "font-family": "ui-sans-serif, system-ui, sans-serif",
            color: colors.fg,
            "text-valign": "bottom",
            "text-margin-y": 6,
            "text-wrap": "ellipsis",
            "text-max-width": "96px",
            "text-background-color": colors.bg,
            "text-background-opacity": 0.85,
            "text-background-padding": "2px",
            "background-color": colors.muted,
            width: 13,
            height: 13,
            "border-width": 2,
            "border-color": colors.bg,
          },
        },
        {
          selector: "node[?center]",
          style: {
            "background-color": colors.fg,
            width: 20,
            height: 20,
            "font-weight": "bold",
            "font-size": 12,
            "z-index": 10,
          },
        },
        { selector: "node[?tracked]", style: { "border-color": colors.accent } },
        { selector: "node[?flagged]", style: { "background-color": colors.danger } },
        {
          selector: "edge",
          style: {
            label: "data(label)",
            "font-size": 8,
            color: colors.muted,
            "text-rotation": "autorotate",
            "text-background-color": colors.bg,
            "text-background-opacity": 0.9,
            "text-background-padding": "2px",
            width: 1,
            "line-color": colors.line,
            "target-arrow-color": colors.line,
            "target-arrow-shape": "triangle",
            "arrow-scale": 0.7,
            "curve-style": "bezier",
          },
        },
        // Hovering isolates one concept's connections. On a dense
        // neighbourhood the edge labels overlap enough that this is the only
        // way to read which relationship goes where.
        { selector: ".dim", style: { opacity: 0.15, "text-opacity": 0 } },
        {
          selector: ".highlight",
          style: {
            "line-color": colors.accent,
            "target-arrow-color": colors.accent,
            color: colors.accent,
            width: 1.8,
            "z-index": 5,
          },
        },
      ],
      // The graph is for reading and navigating; dragging nodes would fight
      // the stable positions that make it readable.
      autoungrabify: true,
      minZoom: 0.3,
      // Zooming to the extent of a four-node graph makes 11px labels look
      // enormous, so cap how far `fit` is allowed to magnify.
      maxZoom: 1.4,
    });

    const refit = () => {
      cy.fit(cy.elements(), 30);
      if (cy.zoom() > 1.4) {
        cy.zoom(1.4);
        cy.center();
      }
    };
    refit();

      cy.on("tap", "node", (event) => {
        const id = event.target.id();
        if (id !== centerId) router.push(`/c/${id}`);
      });

      cy.on("mouseover", "node", (event) => {
        const node = event.target;
        const near = node.closedNeighborhood();
        cy.elements().difference(near).addClass("dim");
        near.edges().addClass("highlight");
        el.style.cursor = node.id() === centerId ? "default" : "pointer";
      });

      cy.on("mouseout", "node", () => {
        cy.elements().removeClass("dim highlight");
        el.style.cursor = "default";
      });

      return { cy, refit };
    };

    let { cy, refit } = build();

    // Cytoscape holds a snapshot of the palette and cannot see a custom
    // property change, so without this the graph keeps the old colours after
    // a theme switch until something remounts it.
    const stopWatching = watchTheme(() => {
      cy.destroy();
      ({ cy, refit } = build());
    });

    const observer = new ResizeObserver(() => refit());
    observer.observe(el);

    return () => {
      stopWatching();
      observer.disconnect();
      cy.destroy();
    };
  }, [centerId, nodes, edges, height, router]);

  return <div ref={container} className={`${styles.canvas} fade-in`} style={{ height }} />;
}
