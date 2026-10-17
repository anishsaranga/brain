import Link from "next/link";
import { notFound } from "next/navigation";
import { getConcept, getNeighbourhood, unlinkedNeighbours, getRevisions } from "@/lib/graph";
import GraphCanvas from "@/components/graph-canvas";
import ConceptEditor from "@/components/concept-editor";

export const dynamic = "force-dynamic";

/**
 * One concept, and the part of the graph it sits in.
 *
 * `getNeighbourhood` is reused rather than reimplemented: it already returns
 * a bounded induced subgraph, clamps depth to 1-3, and reports when it had to
 * cut the node set off.
 */
export default async function ConceptPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ depth?: string }>;
}) {
  const { id } = await params;
  const { depth: rawDepth } = await searchParams;
  const depth = Math.max(1, Math.min(3, Number(rawDepth) || 1));

  const concept = await getConcept(id);
  if (!concept) notFound();

  const [hood, similar, revisions] = await Promise.all([
    getNeighbourhood(concept.id, depth),
    unlinkedNeighbours(concept.id, 5),
    getRevisions(concept.id),
  ]);

  const nodes = [concept, ...(hood?.nodes ?? [])].map((c) => ({
    id: c.id,
    name: c.name,
    tracked: c.tracked,
    flagged: c.flagged,
  }));
  const edges = (hood?.edges ?? []).map((e) => ({ from: e.from, to: e.to, type: e.type }));

  // Nearest concepts that are not already linked — the antidote to a graph
  // of disconnected per-conversation islands.
  const linkedIds = new Set(nodes.map((n) => n.id));
  const unlinked = similar.filter((s) => !linkedIds.has(s.id));

  return (
    <main style={{ maxWidth: 980, margin: "0 auto", padding: "2rem 1.25rem" }}>
      <header style={{ marginBottom: "1.25rem" }}>
        <h1 style={{ fontSize: "1.5rem", margin: "0 0 0.3rem" }}>{concept.name}</h1>
        <p style={{ color: "var(--muted)", fontSize: "0.85rem", margin: 0 }}>
          {concept.topics.length > 0 && <>{concept.topics.join(" · ")} — </>}
          {concept.tracked ? "in review" : "not tracked"}
          {concept.aliases.length > 0 && <> — also {concept.aliases.join(", ")}</>}
        </p>
        {concept.flagged && (
          <p style={{ color: "#d4453d", fontSize: "0.85rem", marginTop: "0.4rem" }}>
            Flagged{concept.flagNote ? `: ${concept.flagNote}` : ""}
          </p>
        )}
      </header>

      <div style={{ display: "grid", gap: "1.5rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
        <section>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.5rem" }}>
            <h2 style={h2}>Neighbourhood</h2>
            <span style={{ fontSize: "0.8rem" }}>
              {[1, 2, 3].map((d) => (
                <Link
                  key={d}
                  href={`/c/${concept.id}?depth=${d}`}
                  style={{
                    marginLeft: "0.5rem",
                    color: d === depth ? "var(--fg)" : "var(--muted)",
                    fontWeight: d === depth ? 600 : 400,
                    textDecoration: "none",
                  }}
                >
                  {d}
                </Link>
              ))}
              <span style={{ color: "var(--muted)", marginLeft: "0.4rem" }}>hops</span>
            </span>
          </div>

          {nodes.length <= 1 ? (
            <p style={muted}>
              Nothing links here yet. An unconnected note is a folder with extra
              steps — try one of the suggestions below.
            </p>
          ) : (
            <GraphCanvas centerId={concept.id} nodes={nodes} edges={edges} />
          )}

          {hood?.truncated && (
            <p style={{ ...muted, marginTop: "0.5rem" }}>
              Showing part of the neighbourhood — it is larger than the display cap.
            </p>
          )}
        </section>

        <ConceptEditor
          id={concept.id}
          name={concept.name}
          body={concept.body}
          prompt={concept.prompt}
          aliases={concept.aliases}
          topics={concept.topics}
          tracked={concept.tracked}
          neighbours={(hood?.nodes ?? []).map((n) => ({ id: n.id, name: n.name }))}
          edges={edges}
          suggestions={unlinked.map((s) => ({ id: s.id, name: s.name, score: s.score }))}
        />

        {revisions.length > 0 && (
          <section>
            <h2 style={h2}>Previous versions</h2>
            <p style={muted}>
              {revisions.length} kept. The newest is from {revisions[0].at.slice(0, 10)}.
            </p>
            <details>
              <summary style={{ cursor: "pointer", fontSize: "0.85rem", color: "var(--muted)" }}>
                Show
              </summary>
              {revisions.map((r) => (
                <pre
                  key={r.at}
                  style={{
                    whiteSpace: "pre-wrap",
                    fontSize: "0.8rem",
                    border: "1px solid var(--line)",
                    borderRadius: 8,
                    padding: "0.6rem",
                    marginTop: "0.5rem",
                  }}
                >
                  {r.body}
                </pre>
              ))}
            </details>
          </section>
        )}
      </div>
    </main>
  );
}

const h2: React.CSSProperties = {
  fontSize: "0.8rem",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--muted)",
  margin: 0,
};
const muted: React.CSSProperties = { color: "var(--muted)", fontSize: "0.85rem" };
