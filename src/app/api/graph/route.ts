import { NextResponse } from "next/server";
import { fullGraph } from "@/lib/graph";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The whole graph, as JSON.
 *
 * A route handler rather than props on the page, so the shell paints before
 * the data arrives. A few thousand nodes serialised into the server-rendered
 * HTML would mean staring at nothing until the whole payload is down, and
 * the point of this page is that it feels instant to open.
 *
 * `requireUser` is called even though the middleware already gates /api/*.
 * Two independent checks, because a matcher that silently stopped covering
 * something is exactly how /search and /trash once served the knowledge base
 * to anyone who asked.
 */
export async function GET(request: Request) {
  // requireUser throws, which a route handler would turn into a 500. A
  // caller whose session expired deserves a 401 it can act on, not a crash.
  try {
    await requireUser();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const limit = Number(new URL(request.url).searchParams.get("limit")) || 1500;
  const graph = await fullGraph(limit);

  return NextResponse.json(graph, {
    // Per-user private data. It must not land in a shared cache, and a stale
    // graph is confusing in a way a slow one is not.
    headers: { "Cache-Control": "private, no-store" },
  });
}
