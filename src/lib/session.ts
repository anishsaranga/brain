import { auth } from "@/lib/auth";
import { isEmailAllowed } from "@/lib/allowlist";

/**
 * Assert a signed-in, allowlisted user, or throw.
 *
 * `middleware.ts` already gates these routes, so in normal operation this
 * never fires. It exists anyway because middleware is one regex away from
 * silently stopping covering a path — add a route that happens to match an
 * exclusion, or edit the matcher, and the gate disappears with no error.
 * Every server action that writes calls this, so the authorisation does not
 * depend on a pattern staying correct.
 */
export async function requireUser(): Promise<{ email: string }> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email || !isEmailAllowed(email)) {
    throw new Error("Not authorised.");
  }
  return { email };
}
