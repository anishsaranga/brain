/**
 * Runs once per server process, before any request is handled.
 *
 * Neo4j takes 20-40s to open Bolt, so the app waits for it and then applies the
 * schema rather than letting the first request discover a missing index. The
 * wait matters on this box specifically: its documented failure mode is an
 * unattended reboot where Docker, Neo4j and the app all cold-start together.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { waitForNeo4j } = await import("@/lib/neo4j");
  const { ensureSchema } = await import("@/lib/schema");

  try {
    await waitForNeo4j();
    const { applied } = await ensureSchema();
    console.log(`[brain] Neo4j reachable, schema applied (${applied} statements)`);
  } catch (err) {
    // Do not throw: that kills the process and compose restarts it in a loop,
    // which hides the real error. Stay up and let /api/health report 503.
    console.error("[brain] startup: Neo4j not ready —", err);
  }
}
