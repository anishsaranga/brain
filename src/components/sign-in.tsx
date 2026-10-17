"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";

/**
 * The button. Split out of the page so the page itself can be a server
 * component and send an already-signed-in visitor away before rendering a
 * login form at them.
 */
export default function SignIn() {
  const params = useSearchParams();
  const [busy, setBusy] = useState(false);

  // `callbackUrl` arrives in the query string, so it is attacker-supplied.
  // Only ever send the browser to a path on this origin: an absolute URL
  // here would be an open redirect.
  const requested = params.get("callbackUrl") ?? "/";
  const callbackUrl =
    requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";

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
        style={{
          width: "100%",
          padding: "0.65rem 0.7rem",
          borderRadius: 8,
          border: "1px solid var(--line)",
          background: "var(--fg)",
          color: "var(--bg)",
          font: "inherit",
          cursor: "pointer",
        }}
      >
        {busy ? "Redirecting…" : "Sign in with Google"}
      </button>
    </>
  );
}
