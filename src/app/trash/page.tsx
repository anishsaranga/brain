import type { Metadata } from "next";
import { listDeleted, deletionImpact } from "@/lib/graph";
import TrashList from "@/components/trash-list";
import { Page, PageHeader, Empty } from "@/components/ui";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Trash" };

/**
 * The only place in the system where data is genuinely destroyed.
 *
 * Everything reachable over MCP is reversible by design: batches undo, bodies
 * keep revisions, delete is a tombstone. Permanent removal was deliberately
 * left out of that surface so it requires a human here, which is only
 * meaningful if this page makes the consequences visible first.
 */
export default async function TrashPage() {
  const deleted = await listDeleted();
  const impacts = await Promise.all(deleted.map((d) => deletionImpact(d.id)));

  return (
    <Page>
      <PageHeader
        title="Trash"
        lead="Deleted concepts keep their links and can be restored. Destroying one is permanent, and it is the only action in this system that cannot be undone. The nightly export is the only copy."
      />

      {deleted.length === 0 ? (
        <Empty>Nothing in the trash.</Empty>
      ) : (
        <TrashList
          items={deleted.map((d, i) => ({
            ...d,
            severs: impacts[i]?.severs ?? [],
          }))}
        />
      )}
    </Page>
  );
}
