import { NextResponse } from "next/server";
import { getDriver } from "@/lib/neo4j";
import { describeSchema } from "@/lib/schema";
import { backupStatus } from "@/lib/backup-status";
import { auth } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness + readiness. The compose healthcheck calls this from inside the
 * container where there is no session, so it is exempt from middleware — which
 * means on a public deployment it is reachable by anyone.
 *
 * It therefore answers at two levels of detail. Unauthenticated callers get
 * only what a monitor needs: is it up, and is the backup stale. The Neo4j
 * version, schema counts and backup filenames are a small map of the box and
 * stay behind a session.
 *
 * Backup staleness does NOT affect the status code either way: it is something
 * to act on, not a reason for Docker to start restarting a working service.
 */
export async function GET() {
  const started = Date.now();
  const session = await auth().catch(() => null);
  const detailed = Boolean(session?.user);
  const backup = backupStatus();

  try {
    const info = await getDriver().getServerInfo();

    if (!detailed) {
      return NextResponse.json({ ok: true, backupStale: backup.stale });
    }

    const { constraints, indexes } = await describeSchema();
    return NextResponse.json({
      ok: true,
      neo4j: { address: info.address, protocol: info.protocolVersion },
      schema: { constraints: constraints.length, indexes: indexes.length },
      backup,
      ms: Date.now() - started,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      detailed
        ? { ok: false, error: message, backup }
        : // Withhold the reason: a connection error names hosts and ports.
          { ok: false, backupStale: backup.stale },
      { status: 503 },
    );
  }
}
