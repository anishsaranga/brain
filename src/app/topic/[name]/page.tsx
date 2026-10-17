import type { Metadata } from "next";
import { conceptsInTopic } from "@/lib/graph";
import { excerpt } from "@/lib/markdown";
import { Page, PageHeader, List, RowLink, Empty, Tag, When, Sub } from "@/components/ui";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ name: string }>;
}): Promise<Metadata> {
  const { name } = await params;
  return { title: decodeURIComponent(name) };
}

export default async function TopicPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const topic = decodeURIComponent(name);
  const concepts = await conceptsInTopic(topic);

  const tracked = concepts.filter((c) => c.tracked).length;

  return (
    <Page>
      <PageHeader
        title={topic}
        lead={
          <>
            {concepts.length} {concepts.length === 1 ? "concept" : "concepts"}
            {tracked > 0 && `, ${tracked} in review`}
          </>
        }
      />

      {concepts.length === 0 ? (
        <Empty>
          Nothing is filed under this topic. It may have been renamed, or every
          concept in it may be in the trash.
        </Empty>
      ) : (
        <List>
          {concepts.map((c) => (
            <RowLink
              key={c.id}
              href={`/c/${c.id}`}
              meta={
                <>
                  {c.flagged && <Tag tone="danger">flagged</Tag>}
                  {c.tracked && <Tag tone="accent">in review</Tag>}
                  <When iso={c.updatedAt} />
                </>
              }
            >
              <span>{c.name}</span>
              {c.body && <Sub>{excerpt(c.body, 120)}</Sub>}
            </RowLink>
          ))}
        </List>
      )}
    </Page>
  );
}
