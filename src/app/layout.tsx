import type { Metadata } from "next";
import Link from "next/link";
import { auth, signOut } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "brain",
  description: "A knowledge graph you feed from Claude and revise over time.",
};

/**
 * The nav only renders for a signed-in user, which keeps it off the login
 * page without the login page needing a layout of its own.
 */
async function Nav() {
  const session = await auth();
  if (!session?.user) return null;

  return (
    <nav
      style={{
        display: "flex",
        alignItems: "center",
        gap: "1rem",
        padding: "0.75rem 1.25rem",
        borderBottom: "1px solid var(--line)",
        fontSize: "0.9rem",
      }}
    >
      <Link href="/" style={{ color: "var(--fg)", fontWeight: 600, textDecoration: "none" }}>
        brain
      </Link>
      <form action="/search" style={{ flex: 1, maxWidth: 420 }}>
        <input
          name="q"
          placeholder="Search your knowledge…"
          aria-label="Search"
          style={{
            width: "100%",
            padding: "0.35rem 0.6rem",
            borderRadius: 8,
            border: "1px solid var(--line)",
            background: "var(--bg)",
            color: "var(--fg)",
            font: "inherit",
            fontSize: "0.85rem",
          }}
        />
      </form>
      <Link href="/trash" style={{ color: "var(--muted)", textDecoration: "none" }}>
        Trash
      </Link>
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/login" });
        }}
      >
        <button
          type="submit"
          style={{
            background: "none",
            border: "none",
            color: "var(--muted)",
            font: "inherit",
            cursor: "pointer",
            padding: 0,
          }}
        >
          Sign out
        </button>
      </form>
    </nav>
  );
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Nav />
        {children}
      </body>
    </html>
  );
}
