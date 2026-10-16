import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { compareSync } from "bcryptjs";

/**
 * Single-admin auth for the web surface, adapted from `learn/src/lib/auth.ts`.
 *
 * Unlike `learn` this app has no `basePath` — it lives at the root of its own
 * subdomain — so none of that service's basePath workarounds are needed here.
 *
 * This gates the UI only. The MCP endpoint has its own auth (a secret path
 * segment plus a Cloudflare WAF rule) and is deliberately exempt in
 * middleware.ts: a connector that received an HTML login redirect would fail
 * in a way that looks like a network fault.
 */

/**
 * Constant-time string comparison. Pure JS rather than `node:crypto` so this
 * module stays loadable in the Edge runtime that middleware imports it from.
 * Length is compared first (it is not secret), then every byte is
 * XOR-accumulated so there is no early-exit timing signal.
 */
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}

function verifyCredentials(username: string, password: string): boolean {
  const expectedUser = process.env.ADMIN_USERNAME ?? "";
  const passwordHash = process.env.ADMIN_PASSWORD_HASH ?? "";
  const plainPassword = process.env.ADMIN_PASSWORD ?? "";

  if (!expectedUser) return false;
  if (!safeEqual(username, expectedUser)) return false;

  // A bcrypt hash takes precedence over plaintext when both are present.
  if (passwordHash) return compareSync(password, passwordHash);
  if (!plainPassword) return false;
  return safeEqual(password, plainPassword);
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 7 },
  pages: { signIn: "/login", error: "/login" },
  providers: [
    Credentials({
      name: "Credentials",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      authorize(credentials) {
        const username =
          typeof credentials?.username === "string" ? credentials.username : "";
        const password =
          typeof credentials?.password === "string" ? credentials.password : "";
        if (!username || !password) return null;
        if (!verifyCredentials(username, password)) return null;
        return { id: "admin", name: username };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) token.id = (user.id as string) ?? "admin";
      return token;
    },
    session({ session, token }) {
      if (session.user) session.user.id = (token.id as string) ?? "admin";
      return session;
    },
  },
});

declare module "next-auth" {
  interface Session {
    user: { id: string } & DefaultSession["user"];
  }
}
