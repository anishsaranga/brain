import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getConcept, getNeighbourhood, unlinkedNeighbours, getRevisions } from "@/lib/graph";
import GraphCanvas from "@/components/graph-canvas";
import ConceptEditor from "@/components/concept-editor";
import Markdown from "@/components/markdown";
import { Page, Section, Tag, Note } from "@/components/ui";
import styles from "./concept.module.css";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const concept = await getConcept(id);
  return { title: concept?.name ?? "Not found" };
}

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

  // Nearest concepts that are not already linked: the antidote to a graph of
  // disconnected per-conversation islands.
  const linkedIds = new Set(nodes.map((n) => n.id));
  const unlinked = similar.filter((s) => !linkedIds.has(s.id));

  return (
    <Page width="wide">
      <header className={styles.head}>
        <h1 className={styles.title}>{concept.name}</h1>
        <div className={styles.meta}>
          {concept.topics.map((t) => (
            <Link key={t} href={`/topic/${encodeURIComponent(t)}`} className={styles.topic}>
              {t}
            </Link>
          ))}
          {concept.tracked && <Tag tone="accent">in review</Tag>}
          {concept.flagged && <Tag tone="danger">flagged</Tag>}
          {concept.aliases.length > 0 && (
            <span className={styles.aliases}>also {concept.aliases.join(", ")}</span>
          )}
        </div>
        {concept.flagged && concept.flagNote && (
          <p className={styles.flagNote}>{concept.flagNote}</p>
        )}
      </header>

      <div className={styles.columns}>
        <div className={styles.main}>
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
            <Section title="Previous versions">
              <Note>
                {revisions.length} kept. The newest is from {revisions[0].at.slice(0, 10)}.
              </Note>
              <details className={styles.revisions}>
                <summary className={styles.summary}>Show</summary>
                {revisions.map((r) => (
                  <article key={r.at} className={styles.revision}>
                    <h3 className={styles.revisionDate}>{r.at.slice(0, 10)}</h3>
                    <Markdown>{r.body}</Markdown>
                  </article>
                ))}
              </details>
            </Section>
          )}
        </div>

        <aside className={styles.aside}>
          <div className={styles.asideHead}>
            <h2 className={styles.asideTitle}>Neighbourhood</h2>
            <span className={styles.hops}>
              {[1, 2, 3].map((d) => (
                <Link
                  key={d}
                  href={`/c/${concept.id}?depth=${d}`}
                  className={d === depth ? styles.hopOn : styles.hop}
                  aria-current={d === depth ? "true" : undefined}
                >
                  {d}
                </Link>
              ))}
              <span className={styles.hopLabel}>hops</span>
            </span>
          </div>

          {nodes.length <= 1 ? (
            <div className={styles.emptyGraph}>
              Nothing links here yet. An unconnected note is a folder with extra
              steps, so try one of the suggestions below the note.
            </div>
          ) : (
            <GraphCanvas centerId={concept.id} nodes={nodes} edges={edges} />
          )}

          {hood?.truncated && (
            <Note>Showing part of the neighbourhood. It is larger than the display cap.</Note>
          )}
        </aside>
      </div>
    </Page>
  );
}
