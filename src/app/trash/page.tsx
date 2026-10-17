import { listDeleted, deletionImpact } from "@/lib/graph";
import TrashList from "@/components/trash-list";

export const dynamic = "force-dynamic";

/**
 * The only place in the system where data is genuinely destroyed.
 *
 * Everything reachable over MCP is reversible by design — batches undo,
 * bodies keep revisions, delete is a tombstone. Permanent removal was
 * deliberately left out of that surface so it requires a human here, which
 * is only meaningful if this page makes the consequences visible first.
 */
export default async function TrashPage() {
  const deleted = await listDeleted();
  const impacts = await Promise.all(deleted.map((d) => deletionImpact(d.id)));

  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: "2rem 1.25rem" }}>
      <h1 style={{ fontSize: "1.3rem", margin: "0 0 0.3rem" }}>Trash</h1>
      <p style={{ color: "var(--muted)", fontSize: "0.85rem", lineHeight: 1.6, margin: "0 0 1.5rem" }}>
        Deleted concepts keep their links and can be restored. Destroying one
        is permanent and is the only action in this system that cannot be
        undone — there is no copy anywhere except the nightly export.
      </p>

      {deleted.length === 0 ? (
        <p style={{ color: "var(--muted)" }}>Nothing in the trash.</p>
      ) : (
        <TrashList
          items={deleted.map((d, i) => ({
            ...d,
            severs: impacts[i]?.severs ?? [],
          }))}
        />
      )}
    </main>
  );
}
