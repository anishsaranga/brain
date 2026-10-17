import NextAuth, { type DefaultSession } from "next-auth";
import Google from "next-auth/providers/google";
import { isAllowedSignIn } from "@/lib/allowlist";

/**
 * Auth for the web surface: Google sign-in, restricted to an allowlist.
 *
 * There is no password anywhere in this app. That is the point — a password
 * is a credential this service would have to store, rotate and get right,
 * and Google already does identity better than a single-admin bcrypt hash
 * ever will. `AUTH_ALLOWED_EMAILS` is what makes an identity an
 * authorisation; the decision itself lives in `@/lib/allowlist` so it can be
 * tested without a Next runtime.
 *
 * `trustHost` is required: the app sits behind a Cloudflare Tunnel, so the
 * Host header it sees is not one it can derive the callback URL from on its
 * own.
 *
 * This gates the UI only. The MCP endpoint has its own auth — a bearer token
 * over a secret path segment — and is deliberately exempt in `middleware.ts`:
 * a connector that received an HTML login redirect would fail in a way that
 * looks like a network fault.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 7 },
  pages: { signIn: "/login", error: "/login" },
  providers: [Google],
  callbacks: {
    /**
     * The gate. Runs once per sign-in, before any session exists.
     *
     * `profile` is the claim set Google returned, so this is the only place
     * `email_verified` can be seen — it is not carried into the session.
     */
    signIn({ profile }) {
      return isAllowedSignIn(profile);
    },

    jwt({ token, profile }) {
      // Carry the address into the token so middleware can re-check it on
      // every request. Without this, revoking access would mean waiting out
      // a seven-day JWT.
      if (profile?.email) token.email = profile.email;
      return token;
    },

    session({ session, token }) {
      if (session.user) {
        session.user.id = (token.sub as string) ?? "user";
        if (typeof token.email === "string") session.user.email = token.email;
      }
      return session;
    },
  },
});

declare module "next-auth" {
  interface Session {
    user: { id: string } & DefaultSession["user"];
  }
}
