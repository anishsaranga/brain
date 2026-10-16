import neo4j, { type Driver, type QueryResult, type RecordShape } from "neo4j-driver";

/**
 * Neo4j driver singleton.
 *
 * The driver owns a connection pool and is meant to live for the lifetime of
 * the process. Next.js re-evaluates modules on HMR in dev, so a plain
 * module-level `const` leaks a fresh driver (and pool) on every edit until the
 * pool exhausts and connections start failing. Stashing it on globalThis keeps
 * exactly one across reloads.
 *
 * The MCP route is stateless per request (mcp-handler v2), which makes a shared
 * long-lived driver more important, not less: every tool call would otherwise
 * pay full connection setup.
 */

const GLOBAL_KEY = Symbol.for("brain.neo4j.driver");

type GlobalWithDriver = typeof globalThis & { [GLOBAL_KEY]?: Driver };
const g = globalThis as GlobalWithDriver;

export function getDriver(): Driver {
  if (g[GLOBAL_KEY]) return g[GLOBAL_KEY];

  const uri = process.env.NEO4J_URI ?? "bolt://localhost:7687";
  const user = process.env.NEO4J_USER ?? "neo4j";
  const password = process.env.NEO4J_PASSWORD;

  if (!password) {
    throw new Error(
      "NEO4J_PASSWORD is not set. Copy .env.example to .env and fill it in.",
    );
  }

  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
    // Fail fast rather than hanging a tool call: claude.ai gives a tool 240s,
    // but a user staring at a spinner gives it far less.
    connectionAcquisitionTimeout: 10_000,
    maxConnectionPoolSize: 20,
  });

  g[GLOBAL_KEY] = driver;
  return driver;
}

/**
 * Run a read query.
 *
 * `executeRead` opens a READ transaction, and the SERVER rejects write clauses
 * inside one. That matters for the `cypher_read` MCP tool: it is a real,
 * server-enforced guarantee rather than a regex over the query string, which is
 * the only honest way to expose arbitrary Cypher. (A dedicated read-only Neo4j
 * user is not an option — role-based access control is Enterprise-only, and
 * Community has a single user.)
 */
export async function read<T extends RecordShape = RecordShape>(
  cypher: string,
  params: Record<string, unknown> = {},
  opts: { timeoutMs?: number } = {},
): Promise<QueryResult<T>> {
  const session = getDriver().session({ defaultAccessMode: neo4j.session.READ });
  try {
    return await session.executeRead((tx) => tx.run<T>(cypher, params), {
      timeout: opts.timeoutMs,
    });
  } finally {
    await session.close();
  }
}

/** Run a write query in a WRITE transaction. */
export async function write<T extends RecordShape = RecordShape>(
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<QueryResult<T>> {
  const session = getDriver().session({ defaultAccessMode: neo4j.session.WRITE });
  try {
    return await session.executeWrite((tx) => tx.run<T>(cypher, params));
  } finally {
    await session.close();
  }
}

/**
 * Wait for Neo4j to accept connections.
 *
 * Neo4j takes 20-40s to open Bolt. Compose `depends_on: service_healthy` covers
 * the normal path, but this box's documented failure mode is an unattended
 * reboot where the whole stack cold-starts at once, so the app retries rather
 * than crash-looping and relying on `unless-stopped` to paper over it.
 */
export async function waitForNeo4j(
  { attempts = 30, delayMs = 2000 } = {},
): Promise<void> {
  let lastError: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      await getDriver().verifyConnectivity();
      return;
    } catch (err) {
      lastError = err;
      if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(
    `Neo4j did not become reachable after ${attempts} attempts: ${String(lastError)}`,
  );
}
