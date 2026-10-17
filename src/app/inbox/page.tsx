import type { Metadata } from "next";
import { listInbox } from "@/lib/graph";
import InboxList from "@/components/inbox-list";
import { Page, PageHeader, Empty } from "@/components/ui";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Inbox" };

/**
 * Captures waiting to become concepts.
 *
 * `capture` has had a write path since milestone 3 and no reader outside
 * MCP, so the "save it now, sort it out later" half of the system was
 * invisible from a browser. An inbox you cannot see is an inbox you do not
 * clear.
 *
 * Captures are raw text, deliberately not markdown and deliberately not
 * embedded: they are material awaiting extraction, not notes.
 */
export default async function InboxPage() {
  const items = await listInbox();

  return (
    <Page>
      <PageHeader
        title="Inbox"
        lead={
          items.length === 0
            ? "Nothing waiting."
            : `${items.length} ${items.length === 1 ? "capture" : "captures"} waiting to be turned into concepts.`
        }
      />

      {items.length === 0 ? (
        <Empty>
          <p style={{ marginTop: 0 }}>
            This is the healthy state, not an empty feature. Captures land here
            when you tell Claude <em>&ldquo;capture this&rdquo;</em> and want the
            raw text kept without deciding yet what it is.
          </p>
          <p style={{ marginBottom: 0 }}>
            To clear one, ask Claude to extract concepts from the inbox. It
            passes the ids back as <code>consumesInbox</code>, so they clear in
            the same transaction that writes the concepts: a failed ingest
            never loses the note.
          </p>
        </Empty>
      ) : (
        <InboxList items={items} />
      )}
    </Page>
  );
}
