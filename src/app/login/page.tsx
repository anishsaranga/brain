import { Suspense } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isEmailAllowed } from "@/lib/allowlist";
import SignIn from "@/components/sign-in";
import styles from "./login.module.css";

export const dynamic = "force-dynamic";

/**
 * Whose brain this is.
 *
 * An env var with a real default rather than a hardcoded string, so the repo
 * stays reusable, but the default is the actual owner because this is a
 * personal instance served from a domain that already carries the name.
 */
const OWNER = process.env.SITE_OWNER?.trim() || "Anish Saranga";

export const metadata: Metadata = {
  title: "Sign in",
  description: `${OWNER}'s second brain.`,
};

/**
 * Deliberately a server component: someone who is already signed in should
 * never be shown a login form. They were, because the layout renders the nav
 * for any session while this page rendered a "sign in" button underneath it,
 * a confusing combination that looked like the nav leaking onto a public page.
 *
 * This is also the only page a stranger ever sees, so it says what the thing
 * is rather than only asking them to sign in.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const { callbackUrl } = await searchParams;
  const session = await auth();

  if (session?.user && isEmailAllowed(session.user.email)) {
    const target =
      callbackUrl?.startsWith("/") && !callbackUrl.startsWith("//") ? callbackUrl : "/";
    redirect(target);
  }

  return (
    <main className={styles.shell}>
      <div className={`${styles.card} fade-in`}>
        <Mark />

        <h1 className={styles.title}>
          <span className={styles.owner}>{OWNER}&rsquo;s</span>
          <span className={styles.second}>second brain</span>
        </h1>

        <p className={styles.lead}>Notes that remember how they connect.</p>

        <Suspense fallback={null}>
          <SignIn />
        </Suspense>

        {/*
          The allowlist is the whole security boundary here, so saying so is
          honest rather than decorative: anyone can complete the Google flow,
          and exactly one address gets in.
        */}
        <p className={styles.footnote}>Private. One account.</p>
      </div>
    </main>
  );
}

/** The same three nodes as the favicon, at a size worth looking at. */
function Mark() {
  return (
    <svg
      className={styles.mark}
      viewBox="0 0 32 32"
      width="44"
      height="44"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.1"
      strokeLinecap="round"
    >
      <path d="M8.5 23.5 16 8.5 24 20" />
      <path d="M8.5 23.5 24 20" />
      <circle cx="8.5" cy="23.5" r="3.6" fill="currentColor" stroke="none" />
      <circle cx="24" cy="20" r="3.6" fill="currentColor" stroke="none" />
      <circle cx="16" cy="8.5" r="4.4" fill="currentColor" stroke="none" />
    </svg>
  );
}
