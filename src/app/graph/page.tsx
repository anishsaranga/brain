import type { Metadata } from "next";
import dynamicImport from "next/dynamic";
import styles from "./graph.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Graph" };

/**
 * The whole graph, filling the screen.
 *
 * Full bleed and full height on purpose: this is the one page whose content
 * IS the page, and a canvas boxed inside an 1180px column with a paragraph
 * underneath reads as an illustration rather than somewhere you work. The
 * chrome that used to sit around it (title, counts, legend, caveats) is
 * overlaid on the canvas instead, so none of it costs vertical space.
 *
 * Lazy in two separate senses, and both are needed:
 *
 * 1. The component, through next/dynamic with ssr: false, so cytoscape and
 *    its layout engine stay out of every other page's bundle. They are by
 *    far the heaviest thing this app ships and nothing else needs them.
 * 2. The data, fetched from /api/graph after mount. A few thousand nodes
 *    serialised into the server-rendered HTML would mean staring at a blank
 *    page until the whole payload arrived.
 *
 * The ego view on a concept page is a different problem and keeps its own
 * renderer: it places nodes on concentric rings by hop distance from the
 * concept you are reading. A whole graph has no centre, so rings are
 * meaningless and a force layout is the right tool here.
 */
const FullGraph = dynamicImport(() => import("@/components/full-graph"));

export default function GraphPage() {
  return (
    <main className={styles.shell}>
      <FullGraph />
    </main>
  );
}
