import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Who is allowed to talk to /mcp.
 *
 * Two credentials, checked in this order:
 *
 *  1. The path segment (`MCP_PATH_SECRET`). Always required. It is what keeps
 *     an unauthenticated probe from learning that anything lives under /mcp at
 *     all, so it stays even once a token is in play.
 *  2. A bearer token (`MCP_BEARER_TOKEN`), carried in a header rather than the
 *     URL. A secret in a URL ends up in request logs, browser history and
 *     screenshots; a header does not.
 *
 * This lives apart from the route because the route cannot be tested without
 * standing up HTTP and Neo4j, and an auth decision is exactly the thing that
 * should be cheap to test.
 */

/** Accepted on either header. See `readToken`. */
const AUTH_HEADER = "authorization";
const CUSTOM_HEADER = "x-brain-token";

export type AuthMode = "off" | "permissive" | "enforcing";

export type AuthOutcome =
  | { ok: true; via: "token" | "path-only" }
  | { ok: false; reason: "bad-path" | "missing-token" | "bad-token" };

export type AuthAttempt = {
  at: string;
  mode: AuthMode;
  pathOk: boolean;
  sawAuthorizationHeader: boolean;
  sawCustomHeader: boolean;
  tokenPresented: boolean;
  tokenMatched: boolean;
  outcome: string;
};

/**
 * Constant-time string compare that does not leak length.
 *
 * `timingSafeEqual` throws on a length mismatch, so the usual workaround is an
 * early `a.length !== b.length` return — which answers "how long is the
 * secret" in variable time. Hashing first makes both sides 32 bytes.
 */
export function constantTimeEquals(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Strip both credentials out of a string before it is shown to anyone.
 *
 * The request URL carries the path secret, so a thrown error that quotes it
 * would hand the credential straight back to the caller.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const secret of [process.env.MCP_PATH_SECRET, process.env.MCP_BEARER_TOKEN]) {
    if (secret) out = out.split(secret).join("<redacted>");
  }
  return out;
}

function truthy(value: string | undefined): boolean {
  return value === "1" || /^(true|yes|on)$/i.test(value ?? "");
}

/**
 * Read the mode from the environment on every call rather than at import, so
 * a container restart is not needed to change it and so the checks can drive
 * all three modes in one process.
 *
 * Note that MCP_REQUIRE_TOKEN wins even with no token configured. That
 * combination is a misconfiguration, and of the two ways to resolve it —
 * silently serving unauthenticated, or refusing everything — refusing is the
 * one that gets noticed. `mcpAuthStatus().tokenConfigured` says which it is.
 */
export function mcpAuthMode(): AuthMode {
  if (truthy(process.env.MCP_REQUIRE_TOKEN)) return "enforcing";
  return process.env.MCP_BEARER_TOKEN ? "permissive" : "off";
}

/**
 * Pull the presented token out of the request.
 *
 * Both header names are accepted because the claude.ai connector dialog's
 * "Request headers" support is a limited beta, and whether it passes a custom
 * `Authorization` through or reserves that name for its own OAuth flow is not
 * something this end of the wire can find out. If one is stripped the other is
 * a change in a dialog rather than a redeploy.
 */
function readToken(req: Request): {
  token?: string;
  sawAuthorizationHeader: boolean;
  sawCustomHeader: boolean;
} {
  const authorization = req.headers.get(AUTH_HEADER);
  const custom = req.headers.get(CUSTOM_HEADER);

  // Scheme is case-insensitive per RFC 9110 §11.1.
  const bearer = authorization?.match(/^\s*Bearer\s+(\S+)\s*$/i)?.[1];
  const token = bearer ?? custom?.trim() ?? undefined;

  return {
    token: token || undefined,
    sawAuthorizationHeader: authorization !== null,
    sawCustomHeader: custom !== null,
  };
}

/**
 * The most recent attempt, for the authenticated half of /api/health.
 *
 * Booleans only — never the token, never a prefix of it. In memory, single
 * process, lost on restart: this is a debugging aid for "did the header
 * actually arrive", not an audit log.
 */
let lastAttempt: AuthAttempt | null = null;

export function lastMcpAuthAttempt(): AuthAttempt | null {
  return lastAttempt;
}

/** Only for the checks, which need a clean slate between cases. */
export function resetMcpAuthAttempt(): void {
  lastAttempt = null;
}

export function mcpAuthStatus(): {
  mode: AuthMode;
  tokenConfigured: boolean;
  lastAttempt: AuthAttempt | null;
} {
  return {
    mode: mcpAuthMode(),
    tokenConfigured: Boolean(process.env.MCP_BEARER_TOKEN),
    lastAttempt,
  };
}

export function authenticateMcp(req: Request, slug: string | undefined): AuthOutcome {
  const mode = mcpAuthMode();
  const pathOk = constantTimeEquals(slug, process.env.MCP_PATH_SECRET);
  const { token, sawAuthorizationHeader, sawCustomHeader } = readToken(req);
  const tokenMatched = constantTimeEquals(token, process.env.MCP_BEARER_TOKEN);

  const outcome = decide({ mode, pathOk, token, tokenMatched });

  lastAttempt = {
    at: new Date().toISOString(),
    mode,
    pathOk,
    sawAuthorizationHeader,
    sawCustomHeader,
    tokenPresented: Boolean(token),
    tokenMatched,
    outcome: outcome.ok ? `ok (${outcome.via})` : outcome.reason,
  };

  return outcome;
}

function decide({
  mode,
  pathOk,
  token,
  tokenMatched,
}: {
  mode: AuthMode;
  pathOk: boolean;
  token?: string;
  tokenMatched: boolean;
}): AuthOutcome {
  if (!pathOk) return { ok: false, reason: "bad-path" };

  if (mode === "enforcing") {
    if (!token) return { ok: false, reason: "missing-token" };
    if (!tokenMatched) return { ok: false, reason: "bad-token" };
    return { ok: true, via: "token" };
  }

  // off, or permissive.
  //
  // Permissive deliberately admits a WRONG token, not just a missing one. Its
  // whole purpose is to be a phase that cannot break the connector while the
  // header is being proven to arrive; rejecting a typo here would reintroduce
  // the failure it exists to avoid. The mismatch shows up in the diagnostic
  // instead, which is where it is actionable.
  return { ok: true, via: tokenMatched ? "token" : "path-only" };
}
