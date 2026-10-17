import type { Metadata } from "next";
import { listOrphans, listFlagged, listStale, listUntopiced, graphStats } from "@/lib/graph";
import { excerpt } from "@/lib/markdown";
import { Page, PageHeader, Section, Stats, Stat, List, RowLink, Empty, Tag, When, Note, Sub } from "@/components/ui";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Hygiene" };

/**
 * The maintenance surface: everything that needs a human rather than a tool.
 *
 * All four lists were available over MCP through `inspect` and nowhere else.
 * They are gathered on one page because they are the same job, done in one
 * sitting: the graph degrades quietly, and nothing about using it day to day
 * surfaces that.
 */
export default async function HygienePage() {
  const [orphans, flagged, stale, untopiced, stats] = await Promise.all([
    listOrphans(50),
    listFlagged(50),
    listStale(25),
    listUntopiced(50),
    graphStats(),
  ]);

  const connected =
    stats.concepts === 0 ? null : Math.round((1 - stats.orphans / stats.concepts) * 100);

  return (
    <Page>
      <PageHeader
        title="Hygiene"
        lead="A knowledge graph degrades quietly. Nothing about using it day to day tells you that a note is wrong or that half of it is unconnected."
      />

      <Stats>
        <Stat label="orphans" value={orphans.length} />
        <Stat
          label="flagged"
          value={flagged.length}
          tone={flagged.length > 0 ? "danger" : undefined}
        />
        <Stat label="no topic" value={untopiced.length} />
        {connected !== null && <Stat label="% connected" value={connected} />}
      </Stats>

      <Section title="Flagged">
        <Note>
          Marked wrong or unclear during a review. These are the highest value
          thing on this page: a note you know is wrong is worse than no note.
        </Note>
        {flagged.length === 0 ? (
          <Empty>Nothing is flagged.</Empty>
        ) : (
          <List>
            {flagged.map((c) => (
              <RowLink key={c.id} href={`/c/${c.id}`} tone="danger" meta={<Tag tone="danger">fix</Tag>}>
                <span>{c.name}</span>
                <Sub>{c.note ?? excerpt(c.body, 110)}</Sub>
              </RowLink>
            ))}
          </List>
        )}
      </Section>

      <Section title="Orphans">
        <Note>
          One link or none. Each conversation is blind to the others, so these
          accumulate unless something deliberately stitches them in. Open one
          and use the <strong>might be related</strong> list underneath the note.
        </Note>
        {orphans.length === 0 ? (
          <Empty>Everything is connected to at least two other concepts.</Empty>
        ) : (
          <List>
            {orphans.map((c) => (
              <RowLink
                key={c.id}
                href={`/c/${c.id}`}
                meta={
                  <>
                    <Tag>{c.links === 0 ? "no links" : "1 link"}</Tag>
                    <When iso={c.createdAt} />
                  </>
                }
              >
                {c.name}
              </RowLink>
            ))}
          </List>
        )}
      </Section>

      <Section title="No topic">
        <Note>
          These do not appear anywhere on the overview, so they are only
          reachable by search or by walking the graph.
        </Note>
        {untopiced.length === 0 ? (
          <Empty>Everything is filed under at least one topic.</Empty>
        ) : (
          <List>
            {untopiced.map((c) => (
              <RowLink key={c.id} href={`/c/${c.id}`} meta={<When iso={c.updatedAt} />}>
                {c.name}
              </RowLink>
            ))}
          </List>
        )}
      </Section>

      <Section title="Least recently reviewed">
        <Note>
          Tracked concepts, longest wait first. Not a backlog: a card that is
          not due is not late.
        </Note>
        {stale.length === 0 ? (
          <Empty>
            Nothing is tracked yet. Storing and rehearsing are separate here, so
            a concept joins the review queue only when you say so.
          </Empty>
        ) : (
          <List>
            {stale.map((c) => (
              <RowLink key={c.id} href={`/c/${c.id}`} meta={<When iso={c.lastReview} />}>
                {c.name}
              </RowLink>
            ))}
          </List>
        )}
      </Section>
    </Page>
  );
}
