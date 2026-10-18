import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { neighbourhoodNotes, type ReadingItem } from "@/lib/graph";
import { UNDIRECTED, relLabel } from "@/lib/rel-types";
import { plainText } from "@/lib/markdown";
import Markdown from "@/components/markdown";
import { Page, Note, Empty } from "@/components/ui";
import styles from "./read.module.css";

export const dynamic = "force-dynamic";

/** Enough notes to learn a subject from, few enough to actually finish. */
const CAP = 40;
const WORDS_PER_MINUTE = 220;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const notes = await neighbourhoodNotes(id, 1, 1);
  return { title: notes ? `Around ${notes.center.name}` : "Not found" };
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
  searchParams: Promise<{ depth?: string }>;
}) {
  const { id } = await params;
  const { depth: rawDepth } = await searchParams;
  const depth = Math.max(1, Math.min(3, Number(rawDepth) || 1));

  const walk = await neighbourhoodNotes(id, depth, CAP);
  if (!walk) notFound();

  const { center, items, truncated } = walk;

  const hops = [...new Set(items.map((i) => i.hop))].sort((a, b) => a - b);
  const words = [center.body, ...items.map((i) => i.concept.body)]
    .map((body) => plainText(body).split(/\s+/).filter(Boolean).length)
    .reduce((a, b) => a + b, 0);
  const minutes = Math.max(1, Math.round(words / WORDS_PER_MINUTE));

  return (
    <Page width="wide">
      <header className={styles.head}>
        <p className={styles.eyebrow}>reading the neighbourhood</p>
        <h1 className={styles.title}>{center.name}</h1>
        <div className={styles.meta}>
          <span className={styles.hops}>
            {[1, 2, 3].map((d) => (
              <Link
                key={d}
                href={`/c/${center.id}/read?depth=${d}`}
                className={d === depth ? styles.hopOn : styles.hop}
                aria-current={d === depth ? "true" : undefined}
              >
                {d}
              </Link>
            ))}
            <span className={styles.hopLabel}>hops</span>
          </span>
          <span className={styles.count}>
            {items.length + 1} {items.length === 0 ? "note" : "notes"} · about {minutes} min
          </span>
          <Link href={`/c/${center.id}`} className={styles.back}>
            back to the note
          </Link>
        </div>
      </header>

      {truncated && (
        <Note>
          Showing the {items.length} best connected within {depth}{" "}
          {depth === 1 ? "hop" : "hops"}. There are more; read at one hop fewer to see a
          whole neighbourhood rather than part of a wider one.
        </Note>
      )}

      <div className={styles.columns}>
        <div className={styles.main}>
          <article className={styles.centre} id={`n-${center.id}`}>
            <h2 className={styles.centreTitle}>{center.name}</h2>
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
              <section key={hop} className={styles.hopSection}>
                <h2 className={styles.hopTitle} id={`hop-${hop}`}>
                  <span>
                    {hop} {hop === 1 ? "hop" : "hops"} away
                  </span>
                  <span className={styles.hopCount}>
                    {items.filter((i) => i.hop === hop).length}
                  </span>
                </h2>

                {items
                  .filter((i) => i.hop === hop)
                  .map((item) => (
                    <article key={item.concept.id} className={styles.note} id={`n-${item.concept.id}`}>
                      <h3 className={styles.noteTitle}>
                        <Link href={`/c/${item.concept.id}`}>{item.concept.name}</Link>
                      </h3>
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
          <p className={styles.tocHead}>In this walk</p>
          <ol className={styles.tocList}>
            <li>
              <a href={`#n-${center.id}`} className={styles.tocCentre}>
                {center.name}
              </a>
            </li>
            {hops.map((hop) => (
              <li key={hop}>
                <a href={`#hop-${hop}`} className={styles.tocHop}>
                  {hop} {hop === 1 ? "hop" : "hops"} away
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
