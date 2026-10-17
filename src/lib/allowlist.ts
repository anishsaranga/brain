/**
 * Who may sign in to the web surface.
 *
 * This is the entire security boundary for the UI. Sign-in is Google OAuth,
 * and any Google account on earth can complete that flow successfully — the
 * provider proves *who* someone is, never that they are allowed in. The
 * allowlist is what turns an identity into an authorisation.
 *
 * It lives apart from `auth.ts` for the same reason `mcp-auth.ts` lives apart
 * from the MCP route: importing `auth.ts` drags in next-auth and a Next
 * runtime, so the decision could not otherwise be tested without standing one
 * up. A security check that cannot be cheaply tested does not get tested.
 *
 * No node: imports. `middleware.ts` runs this in the Edge runtime.
 */

/** Addresses permitted to sign in, lowercased. Empty when unset. */
export function allowedEmails(): string[] {
  return (process.env.AUTH_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Is this address allowed?
 *
 * Fails closed: an unset or empty AUTH_ALLOWED_EMAILS admits nobody. The
 * opposite default would turn a forgotten variable into a world-writable
 * knowledge base, which is exactly the failure nobody notices — the same
 * reasoning as MCP_REQUIRE_TOKEN with no token configured.
 */
export function isEmailAllowed(email: string | null | undefined): boolean {
  const allowed = allowedEmails();
  if (allowed.length === 0) return false;
  const candidate = email?.trim().toLowerCase();
  if (!candidate) return false;
  return allowed.includes(candidate);
}

/** The shape of the bits of an OAuth profile this decision depends on. */
export interface SignInProfile {
  email?: string | null;
  email_verified?: boolean | null;
}

/**
 * Should this profile be allowed to sign in?
 *
 * `email_verified` is checked and not assumed. Google sets it for gmail.com,
 * but a Workspace or custom-domain account can present an address its owner
 * never proved control of — and an unverified address that happens to match
 * the allowlist would otherwise be a way in.
 */
export function isAllowedSignIn(profile: SignInProfile | null | undefined): boolean {
  if (!profile) return false;
  if (profile.email_verified !== true) return false;
  return isEmailAllowed(profile.email);
}
