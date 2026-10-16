"use client";

import { Suspense, useState } from "react";
import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";

/**
 * Deliberately plain. The explorer (milestone 5) brings a component library
 * with it; a login page does not need to wait for that, and does not need to
 * be the thing that introduces one.
 */
function LoginForm() {
  const params = useSearchParams();
  const callbackUrl = params.get("callbackUrl") ?? "/";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const result = await signIn("credentials", {
      username: String(form.get("username") ?? ""),
      password: String(form.get("password") ?? ""),
      redirect: false,
    });

    if (result?.error) {
      // One message for both wrong-username and wrong-password: saying which
      // was wrong tells an attacker whether the username exists.
      setError("Incorrect username or password.");
      setBusy(false);
      return;
    }
    // Only ever send the browser to a path on this origin. A callbackUrl is
    // attacker-controllable via the query string, so an absolute URL here
    // would be an open redirect.
    const safe = callbackUrl.startsWith("/") && !callbackUrl.startsWith("//")
      ? callbackUrl
      : "/";
    window.location.href = safe;
  }

  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: "0.75rem" }}>
      <label style={{ display: "grid", gap: "0.25rem" }}>
        <span style={{ fontSize: "0.8rem", color: "var(--muted)" }}>Username</span>
        <input
          name="username"
          autoComplete="username"
          required
          autoFocus
          style={inputStyle}
        />
      </label>
      <label style={{ display: "grid", gap: "0.25rem" }}>
        <span style={{ fontSize: "0.8rem", color: "var(--muted)" }}>Password</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          style={inputStyle}
        />
      </label>
      {error && (
        <p role="alert" style={{ color: "#d4453d", fontSize: "0.85rem", margin: 0 }}>
          {error}
        </p>
      )}
      <button type="submit" disabled={busy} style={buttonStyle}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "0.55rem 0.7rem",
  borderRadius: 8,
  border: "1px solid var(--line)",
  background: "var(--bg)",
  color: "var(--fg)",
  font: "inherit",
};

const buttonStyle: React.CSSProperties = {
  padding: "0.6rem 0.7rem",
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
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}
