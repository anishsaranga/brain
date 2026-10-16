import { NextResponse } from "next/server";
import { getDriver } from "@/lib/neo4j";
import { describeSchema } from "@/lib/schema";
import { backupStatus } from "@/lib/backup-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness + readiness in one. The compose healthcheck hits this, so it must
 * fail when Neo4j is unreachable — a web container that answers 200 while the
 * graph is down is worse than one that admits it is not ready.
 *
 * Backup freshness is reported but does NOT affect the status code: a stale
 * backup is something to act on, not a reason for Docker to start restarting
 * a service that is otherwise working perfectly.
 */
export async function GET() {
  const started = Date.now();
  const backup = backupStatus();
  try {
    const info = await getDriver().getServerInfo();
    const { constraints, indexes } = await describeSchema();
    return NextResponse.json({
      ok: true,
      neo4j: { address: info.address, protocol: info.protocolVersion },
      schema: { constraints: constraints.length, indexes: indexes.length },
      backup,
      ms: Date.now() - started,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        backup,
      },
      { status: 503 },
    );
  }
}
