import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { getDriver, read } from "@/lib/neo4j";
import * as T from "@/lib/tools";
import { REL_TYPES } from "@/lib/graph";
import { GRADES } from "@/lib/fsrs";
import { CAPS } from "@/lib/ingest";

// The Neo4j driver rules this out of the Edge runtime, and MCP calls are
// inherently dynamic.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * MCP endpoint, mounted under a secret path segment:
 *   /mcp/<MCP_PATH_SECRET>
 *
 * mcp-handler deliberately does not inspect the pathname — it serves any route
 * it is mounted at — so the secret check happens here, before delegating.
 * This is stage-1 auth; the other half is a Cloudflare WAF rule limiting /mcp
 * to Anthropic's egress range. Stage 2 adds OAuth and keeps both.
 */

function secretMatches(candidate: string | undefined): boolean {
  const expected = process.env.MCP_PATH_SECRET;
  if (!expected || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Turn a thrown error into something safe and useful.
 *
 * Never echo the raw message: a Neo4j connection error names internal hosts
 * and ports, and the request URL carries the path secret. The model gets
 * enough to decide what to do next and nothing that maps the deployment.
 */
function safeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const secret = process.env.MCP_PATH_SECRET;
  const redacted = secret ? message.split(secret).join("<redacted>") : message;

  if (/ECONNREFUSED|ServiceUnavailable|Could not perform discovery/i.test(redacted)) {
    return "The knowledge graph database is not reachable right now. Nothing was written.";
  }
  if (/ConstraintValidationFailed/i.test(redacted)) {
    return "That name is already taken by another concept.";
  }
  return redacted.slice(0, 400);
}

/** Wrap a tool so a thrown error becomes a readable result, not a transport fault. */
function tool(fn: () => Promise<T.ToolOutput>) {
  return async () => {
    try {
      return { content: [{ type: "text" as const, text: T.formatToolResult(await fn()) }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${safeError(err)}` }],
        isError: true,
      };
    }
  };
}

const relType = z.enum(REL_TYPES);

const mcpHandler = createMcpHandler(
  (server) => {
    // ── Read ─────────────────────────────────────────────────────────────────

    server.registerTool(
      "search_knowledge",
      {
        title: "Search the knowledge graph",
        description:
          "Find concepts by meaning or by exact wording. Combines full-text " +
          "and semantic search, so it works both for jargon you remember and " +
          "for a vague description. Start here before adding anything, so you " +
          "can link to or merge with what already exists. Returns snippets; " +
          "use get_concept for a full note.",
        inputSchema: z.object({
          query: z.string().min(1).describe("What to look for."),
          limit: z.number().int().min(1).max(25).optional(),
        }),
      },
      ({ query, limit }) => tool(() => T.searchKnowledge(query, limit ?? 10))(),
    );

    server.registerTool(
      "get_concept",
      {
        title: "Read one concept and its neighbourhood",
        description:
          "The full note for one concept plus the concepts it links to. " +
          "Accepts an id, a name or an alias. Depth 1 is the immediate " +
          "neighbours; 2-3 widen it and can be large.",
        inputSchema: z.object({
          idOrName: z.string().min(1),
          depth: z.number().int().min(1).max(3).optional(),
        }),
      },
      ({ idOrName, depth }) => tool(() => T.getConceptTool(idOrName, depth ?? 1))(),
    );

    server.registerTool(
      "suggest_links",
      {
        title: "Find concepts worth linking to this one",
        description:
          "Existing concepts that are semantically near this one but not yet " +
          "linked to it. Each conversation is blind to the others, so without " +
          "deliberate stitching the graph becomes disconnected islands.",
        inputSchema: z.object({ conceptId: z.string().min(1) }),
      },
      ({ conceptId }) => tool(() => T.suggestLinks(conceptId))(),
    );

    server.registerTool(
      "inspect",
      {
        title: "Worklists and graph health",
        description:
          "One of: inbox (raw captures awaiting extraction), flagged " +
          "(marked wrong or unclear during review), orphans (concepts with " +
          "one link or none), stale (tracked but least recently reviewed), " +
          "health (overall counts).",
        inputSchema: z.object({
          what: z.enum(["inbox", "flagged", "orphans", "stale", "health"]),
        }),
      },
      ({ what }) => tool(() => T.inspect(what))(),
    );

    server.registerTool(
      "cypher_read",
      {
        title: "Run a read-only Cypher query",
        description:
          "Escape hatch for graph questions the other tools do not cover, for " +
          "example counting by topic or finding concepts created in a period. " +
          "Read-only and enforced as such by the database. Only pattern " +
          "queries are accepted — MATCH / OPTIONAL MATCH / WITH / WHERE / " +
          "RETURN / ORDER BY / SKIP / LIMIT / UNWIND. CALL, SHOW and LOAD are " +
          "refused. Results are capped at 200 rows, so add your own LIMIT. " +
          "Labels: Concept, Topic, Source, Ingest, Inbox. Exclude deleted " +
          "concepts with `WHERE c.deletedAt IS NULL`.",
        inputSchema: z.object({ query: z.string().min(1) }),
      },
      ({ query }) => tool(() => T.cypherRead(query))(),
    );

    // ── Review ───────────────────────────────────────────────────────────────

    server.registerTool(
      "due_for_review",
      {
        title: "What is due for review",
        description:
          "The spaced-repetition queue. Only concepts explicitly tracked for " +
          "review appear — storing something does not enrol it. Daily caps " +
          "apply, and the result says when a short list is the cap rather " +
          "than an empty queue.",
        inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }),
      },
      ({ limit }) => tool(() => T.dueForReviewTool(limit ?? 20))(),
    );

    server.registerTool(
      "record_review",
      {
        title: "Record how a review went",
        description:
          "Grade a reviewed concept and advance its schedule. 'again' means " +
          "it was not recalled. Refuses concepts that are not tracked.",
        inputSchema: z.object({
          id: z.string().min(1),
          grade: z.enum(GRADES),
        }),
      },
      ({ id, grade }) => tool(() => T.recordReviewTool(id, grade))(),
    );

    // ── Write ────────────────────────────────────────────────────────────────

    server.registerTool(
      "remember",
      {
        title: "Add knowledge to the graph",
        description:
          "Write concepts and the links between them. You do the extraction: " +
          "decide what the concepts are, name them, and say how they relate. " +
          "A concept is one idea you could explain in a paragraph.\n\n" +
          "Per concept the result is created, merged, or AMBIGUOUS. Ambiguous " +
          "means it looked too close to something already stored to decide " +
          "safely — nothing was written for it, and you should call again " +
          "with a `decisions` entry. Everything unambiguous in the same call " +
          "is written regardless.\n\n" +
          "Link `from`/`to` may name concepts created in this same call. " +
          "Links to unknown concepts are skipped and reported rather than " +
          "creating empty placeholders. Always try to link new concepts to " +
          `something that already exists. Limits: ${CAPS.concepts} concepts ` +
          `and ${CAPS.links} links per call.`,
        inputSchema: z.object({
          concepts: z
            .array(
              z.object({
                name: z.string().min(1),
                body: z.string().optional().describe("Markdown. The note itself."),
                aliases: z.array(z.string()).optional(),
                topics: z.array(z.string()).optional(),
                prompt: z
                  .string()
                  .optional()
                  .describe("Optional question to show instead of the name during review."),
              }),
            )
            .max(CAPS.concepts),
          links: z
            .array(
              z.object({
                from: z.string().min(1),
                to: z.string().min(1),
                type: relType,
                note: z.string().optional(),
                weight: z.number().optional(),
              }),
            )
            .max(CAPS.links)
            .optional(),
          source: z
            .object({
              kind: z.enum(["conversation", "url", "book", "paper", "note"]),
              ref: z.string().optional(),
              title: z.string().optional(),
            })
            .optional(),
          decisions: z
            .array(
              z.object({
                name: z.string().min(1),
                action: z.enum(["merge", "new"]),
                mergeIntoId: z.string().optional(),
              }),
            )
            .optional(),
          consumesInbox: z.array(z.string()).optional(),
          idempotencyKey: z
            .string()
            .optional()
            .describe("Stable id for this logical write, so a retry replays instead of duplicating."),
        }),
      },
      (input) => tool(() => T.rememberTool({ ...input, toolCaller: "mcp" }))(),
    );

    server.registerTool(
      "update_concept",
      {
        title: "Edit a concept",
        description:
          "Change a note, rewrite an accreted one, add aliases or topics, " +
          "turn review tracking on or off, or flag it as wrong. Omitted " +
          "fields are left alone; aliases accumulate. The superseded body is " +
          "kept so an overwrite can be undone.",
        inputSchema: z.object({
          id: z.string().min(1),
          patch: z.object({
            body: z.string().optional(),
            prompt: z.string().nullable().optional(),
            aliases: z.array(z.string()).optional(),
            topics: z.array(z.string()).optional(),
            tracked: z.boolean().optional().describe("Enrol in, or remove from, spaced repetition."),
            flagged: z.boolean().optional(),
            flagNote: z.string().nullable().optional(),
          }),
        }),
      },
      ({ id, patch }) => tool(() => T.updateConcept(id, patch))(),
    );

    server.registerTool(
      "delete_concept",
      {
        title: "Delete one concept",
        description:
          "Tombstones a single concept: it disappears from search and review " +
          "but the note and its links survive and can be restored. One id " +
          "per call by design.",
        inputSchema: z.object({ id: z.string().min(1) }),
      },
      ({ id }) => tool(() => T.deleteConceptTool(id))(),
    );

    server.registerTool(
      "restore_concept",
      {
        title: "Undo a delete",
        description: "Bring back a tombstoned concept, with its links.",
        inputSchema: z.object({ id: z.string().min(1) }),
      },
      ({ id }) => tool(() => T.restoreConceptTool(id))(),
    );

    server.registerTool(
      "undo_ingest",
      {
        title: "Reverse one remember call",
        description:
          "Undo a batch using the id returned by remember. Concepts it " +
          "created are tombstoned, bodies it overwrote are restored, and " +
          "links it added are removed. Safe to call twice.",
        inputSchema: z.object({ batchId: z.string().min(1) }),
      },
      ({ batchId }) => tool(() => T.undoIngestTool(batchId))(),
    );

    server.registerTool(
      "ping",
      {
        title: "Check the knowledge graph is reachable",
        description: "Health check. Returns the database version and current counts.",
        inputSchema: z.object({}),
      },
      tool(async () => {
        const info = await getDriver().getServerInfo();
        const result = await read(
          "MATCH (n) RETURN count(n) AS nodes, count{ ()-[]->() } AS rels",
        );
        const rec = result.records[0];
        return {
          summary: `brain is up. Neo4j ${info.agent ?? "unknown"}.`,
          data: {
            nodes: rec?.get("nodes")?.toNumber?.() ?? 0,
            relationships: rec?.get("rels")?.toNumber?.() ?? 0,
          },
        };
      }),
    );

    // ── Prompts ──────────────────────────────────────────────────────────────
    // The house rules, written once here rather than retyped into every
    // conversation. The relationship enum in the tool schema does the heavy
    // lifting for consistency; these cover the judgement the schema cannot.

    server.registerPrompt(
      "ingest_conversation",
      {
        title: "Add this conversation to my knowledge graph",
        description: "Extract concepts and links from what we have been discussing.",
        argsSchema: z.object({
          focus: z.string().optional().describe("Optional: narrow it to one topic."),
        }),
      },
      ({ focus }) => ({
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Add what we have discussed${focus ? ` about ${focus}` : ""} to my ` +
                `knowledge graph. House rules:\n\n` +
                `1. Search first with search_knowledge, so you merge with what exists ` +
                `instead of creating near-duplicates.\n` +
                `2. One concept = one idea I could explain in a paragraph. Not a whole ` +
                `topic, not a single fact.\n` +
                `3. Link every new concept to at least one thing already in the graph. ` +
                `Disconnected notes are just folders.\n` +
                `4. Prefer PREREQUISITE_OF and CONTRASTS_WITH where they genuinely ` +
                `apply — they are what make the graph worth walking.\n` +
                `5. If remember reports anything ambiguous, show me the candidates and ` +
                `ask before deciding.\n` +
                `6. Tell me what you created versus merged, and give me the review link.`,
            },
          },
        ],
      }),
    );

    server.registerPrompt(
      "quiz_me",
      {
        title: "Quiz me on a topic",
        description: "Test recall using what is stored, and record how it went.",
        argsSchema: z.object({
          topic: z.string().describe("Topic or concept to be quizzed on."),
        }),
      },
      ({ topic }) => ({
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Quiz me on ${topic}. Pull the relevant concepts with ` +
                `search_knowledge and get_concept, then ask me one question at a ` +
                `time — do not show me the answer until I have tried.\n\n` +
                `Ask about the CONNECTIONS as well as the facts: what something is a ` +
                `prerequisite for, what it contrasts with. That is the part worth ` +
                `rehearsing in a graph.\n\n` +
                `Afterwards, for any concept that is tracked, call record_review with ` +
                `an honest grade. If I got something wrong because the stored note is ` +
                `itself wrong or unclear, flag it with update_concept instead of ` +
                `marking me down.`,
            },
          },
        ],
      }),
    );
  },
  { serverInfo: { name: "brain", version: "0.4.0" } },
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
