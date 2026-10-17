import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isEmailAllowed } from "@/lib/allowlist";
import SignIn from "@/components/sign-in";

export const dynamic = "force-dynamic";

/**
 * Deliberately plain, and deliberately a server component: someone who is
 * already signed in should never be shown a login form. They were, because
 * the layout renders the nav for any session while this page rendered a
 * "sign in" button underneath it — a confusing combination that looked like
 * the nav leaking onto a public page.
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
    <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: "1rem" }}>
      <div style={{ width: "100%", maxWidth: 320 }}>
        <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.25rem" }}>brain</h1>
        <p style={{ color: "var(--muted)", fontSize: "0.85rem", margin: "0 0 1.25rem" }}>
          Sign in to your knowledge graph.
        </p>
        <Suspense fallback={null}>
          <SignIn />
        </Suspense>
      </div>
    </main>
  );
}
