/**
 * Runs once per server process, before any request is handled.
 *
 * Two jobs, in order: make sure Neo4j is reachable and the schema is applied,
 * then load the embedding model. Both are slow-once and fast-after, and both
 * would otherwise land inside the first MCP tool call.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { waitForNeo4j } = await import("@/lib/neo4j");
  const { ensureSchema } = await import("@/lib/schema");

  try {
    // Neo4j takes 20-40s to open Bolt. Compose `depends_on: service_healthy`
    // covers the normal path, but this box's documented failure mode is an
    // unattended reboot where Docker, Neo4j and the app all cold-start at
    // once, so the app waits rather than crash-looping.
    await waitForNeo4j();
    const { applied } = await ensureSchema();
    console.log(`[brain] Neo4j reachable, schema applied (${applied} statements)`);
  } catch (err) {
    // Do not throw: that kills the process, compose restarts it in a loop, and
    // the real error scrolls away. Stay up and let /api/health report 503.
    console.error("[brain] startup: Neo4j not ready —", err);
  }

  try {
    const { warm } = await import("@/lib/embeddings");
    const { ms, dims } = await warm();
    console.log(`[brain] embedding model warm — ${dims} dims, first inference ${ms}ms`);
  } catch (err) {
    // Same reasoning: search degrades to full-text only, which is far better
    // than a container that will not start.
    console.error("[brain] startup: embedding model failed to load —", err);
  }
}
