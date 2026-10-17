"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import styles from "./sign-in.module.css";

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
        <p role="alert" className={styles.error}>
          {message}
        </p>
      )}
      <button
        type="button"
        disabled={busy}
        className={styles.button}
        onClick={() => {
          setBusy(true);
          void signIn("google", { callbackUrl });
        }}
      >
        <GoogleMark />
        {busy ? "Redirecting…" : "Continue with Google"}
      </button>
    </>
  );
}

/** Google's mark, in its own colours, as their brand terms require. */
function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17Z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7A21.99 21.99 0 0 0 24 46Z"
      />
      <path
        fill="#FBBC05"
        d="M11.69 28.18A13.2 13.2 0 0 1 11 24c0-1.45.25-2.86.69-4.18v-5.7H4.34A21.99 21.99 0 0 0 2 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7Z"
      />
      <path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07Z"
      />
    </svg>
  );
}
