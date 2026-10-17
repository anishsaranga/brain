import { auth } from "@/lib/auth";
import { isEmailAllowed } from "@/lib/allowlist";
import { NextResponse } from "next/server";

/**
 * Gate the web surface.
 *
 * A valid session is not sufficient on its own: the address is re-checked
 * against the allowlist on every request. Sessions are JWTs with a seven-day
 * life, so without this, removing someone from AUTH_ALLOWED_EMAILS would not
 * take effect until their token expired. Revocation should be immediate.
 *
 * Two paths are deliberately NOT gated, and both matter:
 *
 * - `/mcp/*` has its own auth (a bearer token over an unguessable path
 *   segment, inside a Cloudflare WAF rule). Sending a connector a 307 to an
 *   HTML login page would break it in a way that looks like a network fault.
 * - `/api/health` is called by the compose healthcheck from inside the
 *   container, where there is no session. It answers unauthenticated callers
 *   with a deliberately thin body — see that route for what it withholds.
 */
export default auth((req) => {
  if (req.auth && isEmailAllowed(req.auth.user?.email)) {
    return NextResponse.next();
  }

  const { pathname, search, origin } = req.nextUrl;

  // Answer fetch callers with JSON. Without this they would follow the 307 to
  // the login page and then fail parsing HTML as JSON, which is a confusing
  // way to discover your session expired.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const loginUrl = new URL("/login", origin);
  loginUrl.searchParams.set("callbackUrl", `${pathname}${search}`);
  return NextResponse.redirect(loginUrl);
});

export const config = {
  // Everything except: the auth API itself, the login page, the MCP endpoint,
  // the health check, Next internals, and files with an extension.
  // The leading "/" with `$` ensures the root itself is gated — a bare
  // `/((?!…).*)` can skip it.
  // The backslash MUST be escaped. `"\."` in a TypeScript string literal is
  // just `.`, which turned the final alternative into `.*.` — a lookahead
  // matching any non-empty path, which excluded the entire site from the
  // gate. It went unnoticed while `/` was the only page (it is listed
  // separately, and `.*.` cannot match an empty remainder); the moment the
  // explorer added routes, /search and /trash answered 200 to anyone.
  // `scripts/auth-check.mjs` now asserts this pattern's behaviour directly.
  matcher: [
    "/",
    "/((?!api/auth|api/health|mcp|login|_next/static|_next/image|favicon\\.ico|.*\\.).*)",
  ],
};
