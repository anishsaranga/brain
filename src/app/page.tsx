import Link from "next/link";
import { topicOverview, recentConcepts, graphStats } from "@/lib/graph";
import { dueForReview } from "@/lib/fsrs";

export const dynamic = "force-dynamic";

/**
 * The way in that is not a search box.
 *
 * A search box is useless when you do not yet know what you are looking for,
 * which is most of the time with a knowledge base you have been feeding for
 * months. Topics give the shape of what is in there; the counts give you
 * somewhere to start.
 */
export default async function Home() {
  const [{ topics, untopiced }, recent, stats, due] = await Promise.all([
    topicOverview(),
    recentConcepts(10),
    graphStats(),
    dueForReview(1),
  ]);

  if (stats.concepts === 0) {
    return (
      <main style={page}>
        <h1 style={h1}>Nothing here yet</h1>
        <p style={{ color: "var(--muted)", lineHeight: 1.6 }}>
          Your graph is empty. In a Claude conversation with the <code>brain</code>{" "}
          connector enabled, say <em>&ldquo;add this to my knowledge graph&rdquo;</em>, or
          use the <strong>Ingest this conversation</strong> prompt, which carries the
          house rules for granularity and linking.
        </p>
      </main>
    );
  }

  return (
    <main style={page}>
      <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", marginBottom: "2rem" }}>
        <Stat label="concepts" value={stats.concepts} />
        <Stat label="links" value={stats.edges} />
        {/* No link yet: the review session is milestone 6. */}
        <Stat label="due now" value={due.totalDue} />
        <Stat label="orphans" value={stats.orphans} hint="one link or none" />
        {stats.flagged > 0 && <Stat label="flagged" value={stats.flagged} />}
      </div>

      <section style={{ marginBottom: "2.5rem" }}>
        <h2 style={h2}>Topics</h2>
        {topics.length === 0 ? (
          <p style={muted}>
            Nothing is filed under a topic yet. Topics come from the{" "}
            <code>topics</code> field when concepts are written.
          </p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.4rem" }}>
            {topics.map((t) => (
              <li key={t.name}>
                <Link href={`/topic/${encodeURIComponent(t.name)}`} style={rowLink}>
                  <span>{t.name}</span>
                  <span style={muted}>
                    {t.concepts} {t.concepts === 1 ? "concept" : "concepts"}
                    {t.tracked > 0 && ` · ${t.tracked} tracked`}
                  </span>
                </Link>
              </li>
            ))}
            {untopiced > 0 && (
              <li style={{ ...muted, padding: "0.4rem 0" }}>
                and {untopiced} with no topic
              </li>
            )}
          </ul>
        )}
      </section>

      <section>
        <h2 style={h2}>Recently changed</h2>
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.4rem" }}>
          {recent.map((c) => (
            <li key={c.id}>
              <Link href={`/c/${c.id}`} style={rowLink}>
                <span>{c.name}</span>
                <span style={muted}>{c.topics.join(", ")}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function Stat({
  label,
  value,
  hint,
  href,
}: {
  label: string;
  value: number;
  hint?: string;
  href?: string;
}) {
  const body = (
    <>
      <div style={{ fontSize: "1.6rem", lineHeight: 1 }}>{value}</div>
      <div style={{ ...muted, fontSize: "0.8rem", marginTop: "0.2rem" }}>
        {label}
        {hint && <span title={hint}> ⓘ</span>}
      </div>
    </>
  );
  return href ? (
    <Link href={href} style={{ textDecoration: "none", color: "inherit" }}>
      {body}
    </Link>
  ) : (
    <div>{body}</div>
  );
}

const page: React.CSSProperties = { maxWidth: 820, margin: "0 auto", padding: "2.5rem 1.25rem" };
const h1: React.CSSProperties = { fontSize: "1.4rem", margin: "0 0 0.75rem" };
const h2: React.CSSProperties = { fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted)", margin: "0 0 0.6rem" };
const muted: React.CSSProperties = { color: "var(--muted)", fontSize: "0.85rem" };
const rowLink: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "0.5rem 0.7rem",
  border: "1px solid var(--line)",
  borderRadius: 8,
  color: "var(--fg)",
  textDecoration: "none",
};
