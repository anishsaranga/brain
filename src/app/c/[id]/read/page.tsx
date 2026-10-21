import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  neighbourhoodNotes,
  clusterNotes,
  READING_CAP,
  type ReadingItem,
} from "@/lib/graph";
import { UNDIRECTED, relLabel } from "@/lib/rel-types";
import { plainText } from "@/lib/markdown";
import Markdown from "@/components/markdown";
import TrackToggle from "@/components/track-toggle";
import { Page, Note, Empty } from "@/components/ui";
import styles from "./read.module.css";

export const dynamic = "force-dynamic";

const WORDS_PER_MINUTE = 220;

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ mode?: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const { mode } = await searchParams;
  const notes = await neighbourhoodNotes(id, 1, 1);
  if (!notes) return { title: "Not found" };
  return {
    title:
      mode === "cluster"
        ? `Cluster around ${notes.center.name}`
        : `Around ${notes.center.name}`,
  };
}

/**
 * Everything within N links of a concept, as one thing to read.
 *
 * The graph already said which notes belong together. Acting on that meant
 * opening twelve tabs: the connections were visible and the content behind
 * them was not. This is the same breadth-first walk the canvas draws, laid
 * out as prose, in an order you can read top to bottom.
 *
 * Read-only, deliberately. There is a strong pull towards putting the review
 * buttons here, and it is the wrong instinct: /review exists, it schedules
 * with FSRS, and a second place that writes review state would mean two
 * answers to "when is this due". Reading around a concept is not reviewing
 * it.
 */
export default async function ReadPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ depth?: string; mode?: string }>;
}) {
  const { id } = await params;
  const { depth: rawDepth, mode } = await searchParams;
  const depth = Math.max(1, Math.min(3, Number(rawDepth) || 1));
  const wantsCluster = mode === "cluster";

  // A cluster read falls back to one hop rather than 404ing: the only way to
  // have no cluster is for the graph to have outgrown the canvas cap, which
  // is a fact about the graph, not a broken link.
  const group = wantsCluster ? await clusterNotes(id, READING_CAP) : null;
  const walk = group ?? (await neighbourhoodNotes(id, depth, READING_CAP));
  if (!walk) notFound();

  const asCluster = group !== null;
  const { center, items, truncated } = walk;

  // Hops ascending, and the unreachable members of a cluster last.
  const hops = [...new Set(items.map((i) => i.hop))].sort(
    (a, b) => (a ?? Infinity) - (b ?? Infinity),
  );
  const words = [center.body, ...items.map((i) => i.concept.body)]
    .map((body) => plainText(body).split(/\s+/).filter(Boolean).length)
    .reduce((a, b) => a + b, 0);
  const minutes = Math.max(1, Math.round(words / WORDS_PER_MINUTE));

  return (
    <Page width="wide">
      <header className={styles.head}>
        <p className={styles.eyebrow}>
          {asCluster
            ? `reading the ${group.label.text} cluster`
            : "reading the neighbourhood"}
        </p>
        <h1 className={styles.title}>{center.name}</h1>
        <div className={styles.meta}>
          <span className={styles.hops}>
            {[1, 2, 3].map((d) => (
              <Link
                key={d}
                href={`/c/${center.id}/read?depth=${d}`}
                className={!asCluster && d === depth ? styles.hopOn : styles.hop}
                aria-current={!asCluster && d === depth ? "true" : undefined}
              >
                {d}
              </Link>
            ))}
            <span className={styles.hopLabel}>hops</span>
            <Link
              href={`/c/${center.id}/read?mode=cluster`}
              className={asCluster ? styles.hopOn : styles.hop}
              aria-current={asCluster ? "true" : undefined}
              title="Every note in the link community this one belongs to"
            >
              cluster
            </Link>
          </span>
          <span className={styles.count}>
            {items.length + 1} {items.length === 0 ? "note" : "notes"} · about {minutes} min
          </span>
          <Link href={`/c/${center.id}`} className={styles.back}>
            back to the note
          </Link>
        </div>
      </header>

      {wantsCluster && !asCluster && (
        <Note>
          The graph is larger than the canvas groups at once, so this note is not in
          any cluster. Showing one hop around it instead.
        </Note>
      )}

      {truncated &&
        (asCluster ? (
          <Note>
            Showing {items.length} of the {group.size} notes in this cluster, the best
            connected first.
          </Note>
        ) : (
          <Note>
            Showing the {items.length} best connected within {depth}{" "}
            {depth === 1 ? "hop" : "hops"}. There are more; read at one hop fewer to see a
            whole neighbourhood rather than part of a wider one.
          </Note>
        ))}

      <div className={styles.columns}>
        <div className={styles.main}>
          <article className={styles.centre} id={`n-${center.id}`}>
            <div className={styles.noteHead}>
              <h2 className={styles.centreTitle}>{center.name}</h2>
              <TrackToggle id={center.id} tracked={center.tracked} prompt={center.prompt} />
            </div>
            <Topics topics={center.topics} />
            <div className={styles.body}>
              <Markdown>{center.body}</Markdown>
            </div>
          </article>

          {items.length === 0 ? (
            <Empty>
              Nothing links to this one yet, so there is no neighbourhood to read.
              The concept page suggests the nearest notes it is not connected to.
            </Empty>
          ) : (
            hops.map((hop) => (
              <section key={hop ?? "rest"} className={styles.hopSection}>
                <h2 className={styles.hopTitle} id={`hop-${hop ?? "rest"}`}>
                  <span>{hopTitle(hop)}</span>
                  <span className={styles.hopCount}>
                    {items.filter((i) => i.hop === hop).length}
                  </span>
                </h2>

                {items
                  .filter((i) => i.hop === hop)
                  .map((item) => (
                    <article key={item.concept.id} className={styles.note} id={`n-${item.concept.id}`}>
                      <div className={styles.noteHead}>
                        <h3 className={styles.noteTitle}>
                          <Link href={`/c/${item.concept.id}`}>{item.concept.name}</Link>
                        </h3>
                        <TrackToggle
                          id={item.concept.id}
                          tracked={item.concept.tracked}
                          prompt={item.concept.prompt}
                          size="small"
                        />
                      </div>
                      <Relation item={item} />
                      <Topics topics={item.concept.topics} />
                      <div className={styles.body}>
                        <Markdown>{item.concept.body}</Markdown>
                      </div>
                    </article>
                  ))}
              </section>
            ))
          )}
        </div>

        <aside className={styles.toc} aria-label="The notes in this walk">
          <p className={styles.tocHead}>{asCluster ? "In this cluster" : "In this walk"}</p>
          <ol className={styles.tocList}>
            <li>
              <a href={`#n-${center.id}`} className={styles.tocCentre}>
                {center.name}
              </a>
            </li>
            {hops.map((hop) => (
              <li key={hop ?? "rest"}>
                <a href={`#hop-${hop ?? "rest"}`} className={styles.tocHop}>
                  {hopTitle(hop)}
                </a>
                <ol className={styles.tocList}>
                  {items
                    .filter((i) => i.hop === hop)
                    .map((item) => (
                      <li key={item.concept.id}>
                        <a href={`#n-${item.concept.id}`} className={styles.tocLink}>
                          {item.concept.name}
                        </a>
                      </li>
                    ))}
                </ol>
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </Page>
  );
}

/**
 * What a group of notes is, said in the fewest words that stay true.
 *
 * A cluster member with no hop number is one that no link inside the cluster
 * reaches — modularity promises a dense community, not a connected one — so
 * it cannot claim a distance it does not have.
 */
function hopTitle(hop: number | null): string {
  if (hop === null) return "also in this cluster";
  return `${hop} ${hop === 1 ? "hop" : "hops"} away`;
}

function Topics({ topics }: { topics: string[] }) {
  if (topics.length === 0) return null;
  return (
    <div className={styles.topics}>
      {topics.map((t) => (
        <Link key={t} href={`/topic/${encodeURIComponent(t)}`} className={styles.topic}>
          {t}
        </Link>
      ))}
    </div>
  );
}

/**
 * Why this note is here.
 *
 * Written as the triple it actually is rather than as a sentence. "Red-black
 * tree example of this" reads like broken English; subject, relation, object
 * separated out reads as what the graph stores, and the direction is never
 * ambiguous. Relations that mean the same thing both ways are drawn without
 * a direction at all.
 */
function Relation({ item }: { item: ReadingItem }) {
  const { via } = item;
  if (!via) return null;

  const label = relLabel(via.type);
  const other = (
    <Link href={`/c/${via.id}`} className={styles.viaLink}>
      {via.name}
    </Link>
  );
  const self = <span className={styles.viaName}>this note</span>;

  if (UNDIRECTED.has(via.type)) {
    return (
      <p className={styles.via}>
        <span className={styles.viaRel}>{label}</span>
        {other}
      </p>
    );
  }

  // `incoming` means the relationship points at this note, from the other one.
  return (
    <p className={styles.via}>
      {via.incoming ? other : self}
      <span className={styles.viaRel}>{label}</span>
      {via.incoming ? self : other}
    </p>
  );
}
