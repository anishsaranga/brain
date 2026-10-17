import type { Metadata } from "next";
import dynamicImport from "next/dynamic";
import { Page, PageHeader, Note } from "@/components/ui";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Graph" };

/**
 * The whole graph.
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
    <Page width="wide">
      <PageHeader
        title="Graph"
        lead="Everything at once, coloured by topic and sized by how connected it is. Hover to isolate a concept's links, click to open it."
      />
      <FullGraph />
      <Note>
        The layout is seeded from concept ids rather than randomised, so the
        shape is the same every time you open it. That is the only reason a
        picture like this is worth more than a list: you start to recognise
        where things are.
      </Note>
    </Page>
  );
}
