import type { Metadata } from "next";
import { listIngests } from "@/lib/graph";
import { Page, PageHeader, List, RowLink, Empty, Tag, Datum } from "@/components/ui";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Ingested" };

/**
 * Every batch, newest first.
 *
 * `remember` returns a link to one batch, which is only useful while you
 * still have the conversation open. This is how you find the ingest from
 * yesterday that you now think went wrong.
 */
export default async function IngestsPage() {
  const batches = await listIngests();

  return (
    <Page>
      <PageHeader
        title="Ingested"
        lead="Each time Claude wrote to the graph, and what it wrote. Any batch can be reversed."
      />

      {batches.length === 0 ? (
        <Empty>
          Nothing has been ingested yet. In a Claude conversation with the{" "}
          <strong>brain</strong> connector enabled, say{" "}
          <em>&ldquo;add this to my knowledge graph&rdquo;</em>.
        </Empty>
      ) : (
        <List>
          {batches.map((b) => (
            <RowLink
              key={b.id}
              href={`/ingest/${b.id}`}
              meta={
                <>
                  {b.undone && <Tag tone="danger">undone</Tag>}
                  <Datum>{b.at.slice(0, 10)}</Datum>
                </>
              }
            >
              <span>
                {b.created > 0 && `${b.created} created`}
                {b.created > 0 && b.merged > 0 && ", "}
                {b.merged > 0 && `${b.merged} merged`}
                {b.created === 0 && b.merged === 0 && "No concepts"}
                {b.edges > 0 && `, ${b.edges} ${b.edges === 1 ? "link" : "links"}`}
              </span>
            </RowLink>
          ))}
        </List>
      )}
    </Page>
  );
}
