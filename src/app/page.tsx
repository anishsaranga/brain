import { topicOverview, recentConcepts, graphStats } from "@/lib/graph";
import { dueForReview } from "@/lib/fsrs";
import { Page, PageHeader, Section, Stats, Stat, List, RowLink, Empty, Tag, When } from "@/components/ui";

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
      <Page width="read">
        <PageHeader
          title="Nothing here yet"
          lead="This fills up from Claude, not from here. There is no new-note button on purpose."
        />
        <Empty>
          <p style={{ marginTop: 0 }}>
            In a Claude conversation with the <strong>brain</strong> connector enabled,
            say <em>&ldquo;add this to my knowledge graph&rdquo;</em>, or run the{" "}
            <strong>Ingest this conversation</strong> prompt, which carries the house
            rules for granularity and linking.
          </p>
          <p style={{ marginBottom: 0 }}>
            To save something now and sort it out later, say{" "}
            <em>&ldquo;capture this&rdquo;</em>. It lands in the inbox as raw text and
            waits for you.
          </p>
        </Empty>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title="Overview"
        lead="What is in the graph, and where it needs attention."
      />

      <Stats>
        <Stat label="concepts" value={stats.concepts} />
        <Stat label="links" value={stats.edges} />
        <Stat
          label="due now"
          value={due.totalDue}
          href="/review"
          tone={due.totalDue > 0 ? "accent" : undefined}
        />
        <Stat
          label="orphans"
          value={stats.orphans}
          href="/hygiene"
          title="One link or none. An unconnected note is a folder with extra steps."
        />
        {stats.flagged > 0 && (
          <Stat label="flagged" value={stats.flagged} href="/hygiene" tone="danger" />
        )}
      </Stats>

      <Section title="Topics">
        {topics.length === 0 ? (
          <Empty>
            Nothing is filed under a topic yet. Topics come from the{" "}
            <code>topics</code> field when concepts are written, so they appear as
            soon as an ingest sets one.
          </Empty>
        ) : (
          <List>
            {[
              ...topics.map((t) => (
                <RowLink
                  key={t.name}
                  href={`/topic/${encodeURIComponent(t.name)}`}
                  meta={
                    <>
                      {t.tracked > 0 && <Tag tone="accent">{t.tracked} tracked</Tag>}
                      <span>
                        {t.concepts} {t.concepts === 1 ? "concept" : "concepts"}
                      </span>
                    </>
                  }
                >
                  {t.name}
                </RowLink>
              )),
              ...(untopiced > 0
                ? [
                    <RowLink
                      key="__untopiced"
                      href="/hygiene"
                      meta={`${untopiced} ${untopiced === 1 ? "concept" : "concepts"}`}
                    >
                      <span style={{ color: "var(--muted)" }}>No topic</span>
                    </RowLink>,
                  ]
                : []),
            ]}
          </List>
        )}
      </Section>

      <Section title="Recently changed">
        <List>
          {recent.map((c) => (
            <RowLink
              key={c.id}
              href={`/c/${c.id}`}
              meta={
                <>
                  {c.flagged && <Tag tone="danger">flagged</Tag>}
                  {c.topics.length > 0 && <span>{c.topics.join(", ")}</span>}
                  <When iso={c.updatedAt} />
                </>
              }
            >
              {c.name}
            </RowLink>
          ))}
        </List>
      </Section>
    </Page>
  );
}
