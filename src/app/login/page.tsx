"use client";

import { Suspense, useState } from "react";
import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";

/**
 * Deliberately plain. The explorer brings a component library with it; a
 * login page does not need to wait for that, and does not need to be the
 * thing that introduces one.
 *
 * There is no form here because there is no password. Access is a Google
 * account on AUTH_ALLOWED_EMAILS, checked server-side in the signIn callback
 * — this page cannot grant anything by itself.
 */
function SignIn() {
  const params = useSearchParams();
  const [busy, setBusy] = useState(false);

  // `callbackUrl` arrives in the query string, so it is attacker-supplied.
  // Only ever send the browser to a path on this origin: an absolute URL
  // here would be an open redirect.
  const requested = params.get("callbackUrl") ?? "/";
  const callbackUrl =
    requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";

  // Auth.js reports a refused sign-in by bouncing back here with ?error=.
  // AccessDenied is the allowlist rejecting the account, which is the one
  // case worth explaining — everything else is a genuine fault.
  const error = params.get("error");
  const message =
    error === "AccessDenied"
      ? "That Google account is not permitted to sign in."
      : error
        ? "Sign-in failed. Try again."
        : null;

  return (
    <>
      {message && (
        <p role="alert" style={{ color: "#d4453d", fontSize: "0.85rem", margin: "0 0 1rem" }}>
          {message}
        </p>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void signIn("google", { callbackUrl });
        }}
        style={buttonStyle}
      >
        {busy ? "Redirecting…" : "Sign in with Google"}
      </button>
    </>
  );
}

const buttonStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.65rem 0.7rem",
  borderRadius: 8,
  border: "1px solid var(--line)",
  background: "var(--fg)",
  color: "var(--bg)",
  font: "inherit",
  cursor: "pointer",
};

export default function LoginPage() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: "1rem",
      }}
    >
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
