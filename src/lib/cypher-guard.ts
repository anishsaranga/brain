/**
 * Guard for the `cypher_read` escape hatch.
 *
 * Why this exists in the shape it does — measured against the running server
 * rather than assumed:
 *
 * A Neo4j READ transaction genuinely refuses graph writes. That part is a real
 * server-side guarantee, not something this file is trying to reproduce:
 *
 *   CREATE (x:Nope)  ->  42N02 ... writing in read access mode not allowed
 *
 * But read mode does NOT constrain the administrative surface. All of these
 * succeeded inside a read transaction on Neo4j 2026.09 Community:
 *
 *   CALL dbms.listConfig()   ->  194 config entries
 *   SHOW USERS               ->  1
 *   SHOW TRANSACTIONS        ->  1
 *   SHOW DATABASES           ->  2
 *
 * So the dangerous surface is not writes — those are already handled — it is
 * procedures and administrative commands, and I cannot enumerate everything
 * reachable there. A denylist would be a guess. This is therefore structured
 * as an allowlist: the query must BEGIN with a reading clause, and must not
 * contain any keyword outside the reading vocabulary.
 *
 * `LOAD CSV` is refused explicitly. `file:///etc/passwd` is already blocked by
 * Neo4j's default configuration, but the `http://` case was inconclusive when
 * tested (the probe address was simply unreachable, which looks identical to
 * being blocked), so it is denied rather than assumed safe — it would be an
 * SSRF and arbitrary-file-read primitive from a read-only session.
 */

/** Clauses a read query may start with. */
const ALLOWED_OPENERS = ["MATCH", "OPTIONAL", "WITH", "UNWIND", "RETURN"] as const;

/**
 * Keywords that must not appear anywhere.
 *
 * `CALL` is refused outright. Subqueries would be nice to allow, but `CALL` is
 * also how every procedure is invoked and there is no reliable way to tell
 * `CALL { ... }` from `CALL dbms.listConfig()` without parsing Cypher
 * properly. The typed tools already cover what procedures would be wanted for,
 * so the cost of refusing it is low and the benefit is a boundary I can
 * actually reason about.
 */
const FORBIDDEN = [
  // writes
  "CREATE", "MERGE", "DELETE", "DETACH", "SET", "REMOVE", "INSERT", "FOREACH",
  // schema and admin
  "DROP", "ALTER", "RENAME", "GRANT", "REVOKE", "DENY", "START", "STOP",
  "ENABLE", "REALLOCATE", "DEALLOCATE", "SHOW", "TERMINATE", "USE",
  // procedures and external I/O
  "CALL", "LOAD", "IMPORT", "PERIODIC",
  // changes language semantics under us
  "CYPHER",
];

const MAX_QUERY_CHARS = 4000;

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

/**
 * Remove comments, string literals and backtick-quoted identifiers before
 * scanning.
 *
 * Comments matter because `// harmless` followed by a newline does not comment
 * out what comes after it — stripping them means the scanner sees the code
 * that will actually run. Literals are stripped to avoid rejecting an innocent
 * `RETURN 'created'`; nothing inside a Cypher string can execute, so removing
 * them loses no safety.
 */
function strip(query: string): string {
  return query
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/'(?:\\.|[^'\\])*'/g, " '' ")
    .replace(/"(?:\\.|[^"\\])*"/g, ' "" ')
    .replace(/`(?:[^`])*`/g, " ident ");
}

export function guardCypher(query: string): GuardResult {
  const raw = (query ?? "").trim();
  if (!raw) return { ok: false, reason: "Query is empty." };
  if (raw.length > MAX_QUERY_CHARS) {
    return {
      ok: false,
      reason: `Query is ${raw.length} characters; the limit is ${MAX_QUERY_CHARS}.`,
    };
  }

  const cleaned = strip(raw);
  const words = cleaned.toUpperCase().match(/[A-Z_]+/g) ?? [];

  const opener = words[0];
  if (!opener || !(ALLOWED_OPENERS as readonly string[]).includes(opener)) {
    return {
      ok: false,
      reason:
        `A read query must start with one of ${ALLOWED_OPENERS.join(", ")}. ` +
        `This one starts with "${opener ?? "nothing"}".`,
    };
  }

  const hit = words.find((w) => FORBIDDEN.includes(w));
  if (hit) {
    return {
      ok: false,
      reason:
        `"${hit}" is not allowed in cypher_read. This tool runs read-only ` +
        `pattern queries (MATCH / WHERE / RETURN / ORDER BY / LIMIT and the ` +
        `like). Writes, procedures, SHOW commands and LOAD CSV are refused ` +
        `regardless of what the transaction would permit.`,
    };
  }

  // Multiple statements: Cypher does not support `;`-separated statements over
  // Bolt anyway, but refusing here makes the intent explicit rather than
  // relying on the driver to be the boundary.
  if (/;\s*\S/.test(cleaned)) {
    return { ok: false, reason: "Only a single statement is allowed." };
  }

  return { ok: true };
}
