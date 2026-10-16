import { NextResponse } from "next/server";
import { getDriver } from "@/lib/neo4j";
import { describeSchema } from "@/lib/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness + readiness in one. The compose healthcheck hits this, so it must
 * fail when Neo4j is unreachable — a web container that answers 200 while the
 * graph is down is worse than one that admits it is not ready.
 */
export async function GET() {
  const started = Date.now();
  try {
    const info = await getDriver().getServerInfo();
    const { constraints, indexes } = await describeSchema();
    return NextResponse.json({
      ok: true,
      neo4j: { address: info.address, protocol: info.protocolVersion },
      schema: { constraints: constraints.length, indexes: indexes.length },
      ms: Date.now() - started,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 503 },
    );
  }
}
