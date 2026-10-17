"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { saveConcept, addLink, removeLink, trashConcept, type ActionResult } from "@/app/actions";
import { REL_TYPES, relLabel } from "@/lib/rel-types";

interface Neighbour {
  id: string;
  name: string;
}

/**
 * Editing on the canvas.
 *
 * Nothing here is destructive. Saving keeps the superseded body as a
 * revision, and the delete button is a tombstone — permanent removal lives on
 * /trash and takes a second deliberate step.
 */
export default function ConceptEditor({
  id,
  name,
  body,
  prompt,
  aliases,
  topics,
  tracked,
  neighbours,
  edges,
  suggestions,
}: {
  id: string;
  name: string;
  body: string;
  prompt: string | null;
  aliases: string[];
  topics: string[];
  tracked: boolean;
  neighbours: Neighbour[];
  edges: Array<{ from: string; to: string; type: string }>;
  suggestions: Array<{ id: string; name: string; score: number }>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [editing, setEditing] = useState(false);

  const [draft, setDraft] = useState({
    name,
    body,
    prompt: prompt ?? "",
    aliases: aliases.join(", "),
    topics: topics.join(", "),
    tracked,
  });

  const run = (fn: () => Promise<ActionResult>) =>
    start(async () => {
      setResult(await fn());
      router.refresh();
    });

  const nameOf = (nid: string) =>
    nid === id ? name : (neighbours.find((n) => n.id === nid)?.name ?? nid);

  const direct = edges.filter((e) => e.from === id || e.to === id);

  return (
    <section style={{ display: "grid", gap: "1.25rem" }}>
      {result && (
        <p
          role="status"
          style={{
            margin: 0,
            fontSize: "0.85rem",
            color: result.ok ? "var(--muted)" : "#d4453d",
          }}
        >
          {result.ok ? result.message : result.error}
        </p>
      )}

      {/* ── The note ───────────────────────────────────────────────────── */}
      <div>
        <div style={headerRow}>
          <h2 style={h2}>Note</h2>
          <button type="button" onClick={() => setEditing((v) => !v)} style={linkButton}>
            {editing ? "Cancel" : "Edit"}
          </button>
        </div>

        {editing ? (
          <div style={{ display: "grid", gap: "0.6rem" }}>
            <Field label="Name">
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                style={input}
              />
            </Field>
            <Field label="Body (markdown)">
              <textarea
                value={draft.body}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                rows={12}
                style={{ ...input, fontFamily: "ui-monospace, monospace", fontSize: "0.85rem" }}
              />
            </Field>
            <Field label="Review prompt (optional)">
              <input
                value={draft.prompt}
                onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
                placeholder="Question to show instead of the name"
                style={input}
              />
            </Field>
            <Field label="Aliases (comma separated)">
              <input
                value={draft.aliases}
                onChange={(e) => setDraft({ ...draft, aliases: e.target.value })}
                style={input}
              />
            </Field>
            <Field label="Topics (comma separated)">
              <input
                value={draft.topics}
                onChange={(e) => setDraft({ ...draft, topics: e.target.value })}
                style={input}
              />
            </Field>
            <label style={{ fontSize: "0.85rem", display: "flex", gap: "0.4rem", alignItems: "center" }}>
              <input
                type="checkbox"
                checked={draft.tracked}
                onChange={(e) => setDraft({ ...draft, tracked: e.target.checked })}
              />
              In spaced repetition
            </label>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button
                type="button"
                disabled={pending}
                style={button}
                onClick={() =>
                  run(async () => {
                    const r = await saveConcept(id, {
                      name: draft.name,
                      body: draft.body,
                      prompt: draft.prompt.trim() === "" ? null : draft.prompt,
                      aliases: splitList(draft.aliases),
                      topics: splitList(draft.topics),
                      tracked: draft.tracked,
                    });
                    if (r.ok) setEditing(false);
                    return r;
                  })
                }
              >
                {pending ? "Saving…" : "Save"}
              </button>
              <span style={{ ...muted, alignSelf: "center" }}>
                The current version is kept and can be recovered.
              </span>
            </div>
          </div>
        ) : (
          <pre style={bodyBlock}>{body || "No note yet."}</pre>
        )}
      </div>

      {/* ── Links ──────────────────────────────────────────────────────── */}
      <div>
        <h2 style={h2}>Links</h2>
        {direct.length === 0 ? (
          <p style={muted}>None yet.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: "0.4rem 0 0", display: "grid", gap: "0.3rem" }}>
            {direct.map((e) => {
              const otherId = e.from === id ? e.to : e.from;
              return (
                <li key={`${e.from}-${e.to}-${relLabel(e.type)}`} style={linkRow}>
                  <span style={{ fontSize: "0.85rem" }}>
                    <span style={muted}>
                      {e.from === id ? "" : `${nameOf(otherId)} `}
                      {relLabel(e.type)}
                      {e.from === id ? " " : ""}
                    </span>
                    <Link href={`/c/${otherId}`} style={{ color: "var(--fg)" }}>
                      {e.from === id ? nameOf(otherId) : "this"}
                    </Link>
                  </span>
                  <button
                    type="button"
                    disabled={pending}
                    style={linkButton}
                    onClick={() => run(() => removeLink(e.from, e.to, e.type))}
                  >
                    remove
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <AddLink id={id} candidates={[...suggestions, ...neighbours.map((n) => ({ ...n, score: 0 }))]} pending={pending} onRun={run} />
      </div>

      {/* ── Suggestions ────────────────────────────────────────────────── */}
      {suggestions.length > 0 && (
        <div>
          <h2 style={h2}>Might be related</h2>
          <p style={muted}>
            Near this one but not linked. Each conversation is blind to the
            others, so these are the connections nothing has made yet.
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: "0.4rem 0 0", display: "grid", gap: "0.3rem" }}>
            {suggestions.map((s) => (
              <li key={s.id} style={linkRow}>
                <Link href={`/c/${s.id}`} style={{ color: "var(--fg)", fontSize: "0.85rem" }}>
                  {s.name}
                </Link>
                <span style={muted}>{s.score.toFixed(2)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Delete ─────────────────────────────────────────────────────── */}
      <div style={{ borderTop: "1px solid var(--line)", paddingTop: "0.9rem" }}>
        <button
          type="button"
          disabled={pending}
          style={{ ...linkButton, color: "#d4453d" }}
          onClick={() =>
            run(async () => {
              const r = await trashConcept(id);
              if (r.ok) router.push("/");
              return r;
            })
          }
        >
          Move to trash
        </button>
        <span style={{ ...muted, marginLeft: "0.6rem" }}>
          Reversible. Links survive. Permanent removal is a separate step on
          the trash page.
        </span>
      </div>
    </section>
  );
}

function AddLink({
  id,
  candidates,
  pending,
  onRun,
}: {
  id: string;
  candidates: Array<{ id: string; name: string }>;
  pending: boolean;
  onRun: (fn: () => Promise<ActionResult>) => void;
}) {
  const [target, setTarget] = useState("");
  const [type, setType] = useState<string>(REL_TYPES[0]);

  const unique = Array.from(new Map(candidates.map((c) => [c.id, c])).values()).filter(
    (c) => c.id !== id,
  );
  if (unique.length === 0) return null;

  return (
    <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.6rem", flexWrap: "wrap" }}>
      <select value={type} onChange={(e) => setType(e.target.value)} style={{ ...input, width: "auto" }}>
        {REL_TYPES.map((t) => (
          <option key={t} value={t}>
            {relLabel(t)}
          </option>
        ))}
      </select>
      <select value={target} onChange={(e) => setTarget(e.target.value)} style={{ ...input, width: "auto", flex: 1 }}>
        <option value="">choose a concept…</option>
        {unique.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={pending || !target}
        style={button}
        onClick={() => onRun(() => addLink(id, target, type))}
      >
        Link
      </button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: "0.2rem" }}>
      <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>{label}</span>
      {children}
    </label>
  );
}

const splitList = (value: string) =>
  value.split(",").map((s) => s.trim()).filter(Boolean);

const h2: React.CSSProperties = {
  fontSize: "0.8rem",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--muted)",
  margin: 0,
};
const headerRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  marginBottom: "0.4rem",
};
const muted: React.CSSProperties = { color: "var(--muted)", fontSize: "0.8rem" };
const input: React.CSSProperties = {
  width: "100%",
  padding: "0.45rem 0.6rem",
  borderRadius: 8,
  border: "1px solid var(--line)",
  background: "var(--bg)",
  color: "var(--fg)",
  font: "inherit",
  fontSize: "0.9rem",
};
const button: React.CSSProperties = {
  padding: "0.45rem 0.9rem",
  borderRadius: 8,
  border: "1px solid var(--line)",
  background: "var(--fg)",
  color: "var(--bg)",
  font: "inherit",
  fontSize: "0.85rem",
  cursor: "pointer",
};
const linkButton: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--muted)",
  font: "inherit",
  fontSize: "0.8rem",
  cursor: "pointer",
  padding: 0,
};
const linkRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "1rem",
  padding: "0.4rem 0.6rem",
  border: "1px solid var(--line)",
  borderRadius: 8,
};
const bodyBlock: React.CSSProperties = {
  whiteSpace: "pre-wrap",
  fontFamily: "inherit",
  fontSize: "0.92rem",
  lineHeight: 1.6,
  margin: "0.4rem 0 0",
  padding: "0.8rem",
  border: "1px solid var(--line)",
  borderRadius: 8,
};
