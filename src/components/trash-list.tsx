"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { untrashConcept, destroyConcept, type ActionResult } from "@/app/actions";
import { relLabel } from "@/lib/rel-types";

interface TrashItem {
  id: string;
  name: string;
  deletedAt: string;
  edges: number;
  severs: Array<{ id: string; name: string; type: string }>;
}

export default function TrashList({ items }: { items: TrashItem[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  const run = (fn: () => Promise<ActionResult>) =>
    start(async () => {
      setResult(await fn());
      setConfirming(null);
      setTyped("");
      router.refresh();
    });

  return (
    <>
      {result && (
        <p
          role="status"
          style={{
            fontSize: "0.85rem",
            color: result.ok ? "var(--muted)" : "#d4453d",
            marginBottom: "1rem",
          }}
        >
          {result.ok ? result.message : result.error}
        </p>
      )}

      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.6rem" }}>
        {items.map((item) => (
          <li
            key={item.id}
            style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "0.7rem 0.9rem" }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "baseline" }}>
              <strong>{item.name}</strong>
              <span style={muted}>deleted {item.deletedAt.slice(0, 10)}</span>
            </div>

            {confirming === item.id ? (
              <div style={{ marginTop: "0.7rem" }}>
                {/* The consequences, before the control that causes them. The
                    note is one paragraph you could rewrite; the connections
                    to it are the thinking you cannot. */}
                {item.severs.length > 0 ? (
                  <p style={{ ...muted, lineHeight: 1.6, margin: "0 0 0.5rem" }}>
                    This also destroys {item.severs.length}{" "}
                    {item.severs.length === 1 ? "link" : "links"}, leaving{" "}
                    {item.severs.map((s, i) => (
                      <span key={s.id}>
                        {i > 0 && ", "}
                        <strong style={{ color: "var(--fg)", fontWeight: 500 }}>{s.name}</strong>{" "}
                        <span style={{ opacity: 0.8 }}>({relLabel(s.type)})</span>
                      </span>
                    ))}{" "}
                    without it.
                  </p>
                ) : (
                  <p style={{ ...muted, margin: "0 0 0.5rem" }}>
                    Nothing links to this, so nothing else changes.
                  </p>
                )}

                <label style={{ display: "block", ...muted, marginBottom: "0.35rem" }}>
                  Type <strong style={{ color: "var(--fg)" }}>{item.name}</strong> to confirm.
                </label>
                <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                  <input
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    autoFocus
                    style={{
                      flex: 1,
                      minWidth: 200,
                      padding: "0.4rem 0.6rem",
                      borderRadius: 8,
                      border: "1px solid var(--line)",
                      background: "var(--bg)",
                      color: "var(--fg)",
                      font: "inherit",
                      fontSize: "0.9rem",
                    }}
                  />
                  <button
                    type="button"
                    // The server checks this too — the guard cannot live only
                    // in a form, or a stray fetch would not have to pass it.
                    disabled={pending || typed.trim() !== item.name}
                    onClick={() => run(() => destroyConcept(item.id, typed))}
                    style={{
                      padding: "0.4rem 0.9rem",
                      borderRadius: 8,
                      border: "1px solid #d4453d",
                      background: typed.trim() === item.name ? "#d4453d" : "transparent",
                      color: typed.trim() === item.name ? "#fff" : "#d4453d",
                      font: "inherit",
                      fontSize: "0.85rem",
                      cursor: typed.trim() === item.name ? "pointer" : "not-allowed",
                    }}
                  >
                    Destroy permanently
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirming(null);
                      setTyped("");
                    }}
                    style={linkButton}
                  >
                    cancel
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", gap: "0.9rem", marginTop: "0.5rem", alignItems: "center" }}>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => untrashConcept(item.id))}
                  style={linkButton}
                >
                  restore
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    setConfirming(item.id);
                    setTyped("");
                  }}
                  style={{ ...linkButton, color: "#d4453d" }}
                >
                  destroy permanently
                </button>
                {item.edges > 0 && (
                  <span style={muted}>
                    {item.edges} {item.edges === 1 ? "link" : "links"} attached
                  </span>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

const muted: React.CSSProperties = { color: "var(--muted)", fontSize: "0.8rem" };
const linkButton: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--muted)",
  font: "inherit",
  fontSize: "0.8rem",
  cursor: "pointer",
  padding: 0,
};
