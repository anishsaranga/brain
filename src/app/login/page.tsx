import { Suspense } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isEmailAllowed } from "@/lib/allowlist";
import SignIn from "@/components/sign-in";
import styles from "./login.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Sign in" };

/**
 * Deliberately a server component: someone who is already signed in should
 * never be shown a login form. They were, because the layout renders the nav
 * for any session while this page rendered a "sign in" button underneath it,
 * a confusing combination that looked like the nav leaking onto a public page.
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
        <h1 className={styles.title}>brain</h1>
        <p className={styles.lead}>
          A knowledge graph you feed from Claude, walk through, and revise over
          time.
        </p>
        <Suspense fallback={null}>
          <SignIn />
        </Suspense>
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
      width="40"
      height="40"
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
