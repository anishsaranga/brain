import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { getDriver, read } from "@/lib/neo4j";

// The Neo4j driver rules this out of the Edge runtime, and MCP calls are
// inherently dynamic.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * MCP endpoint, mounted under a secret path segment:
 *   /mcp/<MCP_PATH_SECRET>
 *
 * mcp-handler deliberately does not inspect the pathname — it serves any route
 * it is mounted at — so the secret check has to happen here, before delegating.
 * This is stage-1 auth. The other half is a Cloudflare WAF rule limiting /mcp
 * to Anthropic's egress range (160.79.104.0/21); see DEPLOY.md. Stage 2 adds
 * real OAuth and keeps both.
 */

function secretMatches(candidate: string | undefined): boolean {
  const expected = process.env.MCP_PATH_SECRET;
  if (!expected || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so compare lengths first — but
  // only after building both buffers, so the common path stays constant-time.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const mcpHandler = createMcpHandler(
  (server) => {
    server.registerTool(
      "ping",
      {
        title: "Ping the knowledge graph",
        description:
          "Health check for the knowledge graph service. Returns the Neo4j " +
          "server version and the current node count. Use this to confirm the " +
          "connector is wired up correctly.",
        inputSchema: z.object({}),
      },
      async () => {
        const info = await getDriver().getServerInfo();
        const result = await read(
          "MATCH (n) RETURN count(n) AS nodes, count{ ()-[]->() } AS rels",
        );
        const rec = result.records[0];
        // Neo4j returns 64-bit integers; toNumber() is safe at these counts and
        // keeps the JSON plain rather than {low, high}.
        const nodes = rec?.get("nodes")?.toNumber?.() ?? 0;
        const rels = rec?.get("rels")?.toNumber?.() ?? 0;

        return {
          content: [
            {
              type: "text",
              text:
                `brain is up.\n` +
                `Neo4j ${info.agent ?? "unknown"} at ${info.address}\n` +
                `${nodes} nodes, ${rels} relationships.`,
            },
          ],
        };
      },
    );
  },
  {
    serverInfo: { name: "brain", version: "0.1.0" },
  },
);

async function handle(
  req: Request,
  ctx: { params: Promise<{ slug?: string[] }> },
): Promise<Response> {
  const { slug } = await ctx.params;
  if (!secretMatches(slug?.[0])) {
    // 404, not 401: an unauthenticated caller should not be able to tell that
    // anything lives under /mcp at all.
    return new Response("Not found", { status: 404 });
  }
  return mcpHandler(req);
}

export { handle as GET, handle as POST, handle as DELETE };
