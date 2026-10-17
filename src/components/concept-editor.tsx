"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { saveConcept, addLink, removeLink, trashConcept, type ActionResult } from "@/app/actions";
import { REL_TYPES, relLabel } from "@/lib/rel-types";
import Markdown from "./markdown";
import styles from "./concept-editor.module.css";
import ui from "./ui.module.css";

interface Neighbour {
  id: string;
  name: string;
}

/**
 * Editing on the canvas.
 *
 * Nothing here is destructive. Saving keeps the superseded body as a
 * revision, and the delete button is a tombstone: permanent removal lives on
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
  const [preview, setPreview] = useState(false);

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
    <div className={styles.wrap}>
      {result && (
        <p role="status" className={result.ok ? styles.ok : styles.bad}>
          {result.ok ? result.message : result.error}
        </p>
      )}

      {/* ── The note ─────────────────────────────────────────────────────── */}
      <section className={ui.section}>
        <div className={ui.sectionHead}>
          <h2 className={ui.sectionTitle}>Note</h2>
          <div className={styles.headActions}>
            {editing && (
              <div className={styles.tabs} role="tablist" aria-label="Editor mode">
                <button
                  type="button"
                  role="tab"
                  aria-selected={!preview}
                  className={!preview ? styles.tabOn : styles.tab}
                  onClick={() => setPreview(false)}
                >
                  Write
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={preview}
                  className={preview ? styles.tabOn : styles.tab}
                  onClick={() => setPreview(true)}
                >
                  Preview
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                setEditing((v) => !v);
                setPreview(false);
              }}
              className={styles.quiet}
            >
              {editing ? "Cancel" : "Edit"}
            </button>
          </div>
        </div>

        {editing ? (
          <div className={styles.form}>
            <Field label="Name">
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                className={styles.input}
              />
            </Field>

            <Field label="Body" hint="Markdown. Headings, lists, tables and code all render.">
              {preview ? (
                <div className={styles.previewPane}>
                  {draft.body.trim() ? (
                    <Markdown>{draft.body}</Markdown>
                  ) : (
                    <p className={styles.placeholder}>Nothing to preview yet.</p>
                  )}
                </div>
              ) : (
                <textarea
                  value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                  rows={14}
                  spellCheck
                  className={`${styles.input} ${styles.textarea}`}
                />
              )}
            </Field>

            <Field label="Review prompt" hint="Optional. Asked instead of the name during review.">
              <input
                value={draft.prompt}
                onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
                placeholder="Why does Raft need a majority?"
                className={styles.input}
              />
            </Field>

            <div className={styles.pair}>
              <Field label="Aliases" hint="Comma separated.">
                <input
                  value={draft.aliases}
                  onChange={(e) => setDraft({ ...draft, aliases: e.target.value })}
                  className={styles.input}
                />
              </Field>
              <Field label="Topics" hint="Comma separated.">
                <input
                  value={draft.topics}
                  onChange={(e) => setDraft({ ...draft, topics: e.target.value })}
                  className={styles.input}
                />
              </Field>
            </div>

            <label className={styles.check}>
              <input
                type="checkbox"
                checked={draft.tracked}
                onChange={(e) => setDraft({ ...draft, tracked: e.target.checked })}
              />
              <span>
                In spaced repetition
                <span className={styles.checkHint}>
                  Most notes are reference material you want to find, not memorise.
                </span>
              </span>
            </label>

            <div className={styles.actions}>
              <button
                type="button"
                disabled={pending}
                className={styles.primary}
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
              <span className={ui.note}>The current version is kept and can be recovered.</span>
            </div>
          </div>
        ) : body.trim() ? (
          <Markdown>{body}</Markdown>
        ) : (
          <p className={styles.placeholder}>No note yet.</p>
        )}
      </section>

      {/* ── Links ────────────────────────────────────────────────────────── */}
      <section className={ui.section}>
        <div className={ui.sectionHead}>
          <h2 className={ui.sectionTitle}>Links</h2>
        </div>

        {direct.length === 0 ? (
          <p className={styles.placeholder}>None yet.</p>
        ) : (
          <ul className={`${ui.list} stagger`}>
            {direct.map((e, i) => {
              const otherId = e.from === id ? e.to : e.from;
              return (
                <li
                  key={`${e.from}-${e.to}-${e.type}`}
                  style={{ "--i": Math.min(i, 14) } as React.CSSProperties}
                >
                  <div className={ui.row}>
                    {/*
                      Direction is most of what a link means, so the row has
                      to read as a sentence in the right order: outgoing is
                      "contrasts with Paxos", incoming is "Quorum prerequisite
                      of this". Leading with the relation either way produced
                      "part of Replicated log this".
                    */}
                    <span className={styles.linkText}>
                      {e.from === id ? (
                        <>
                          <span className={styles.rel}>{relLabel(e.type)}</span>
                          <Link href={`/c/${otherId}`} className={styles.linkTarget}>
                            {nameOf(otherId)}
                          </Link>
                        </>
                      ) : (
                        <>
                          <Link href={`/c/${otherId}`} className={styles.linkTarget}>
                            {nameOf(otherId)}
                          </Link>
                          <span className={styles.rel}>{relLabel(e.type)} this</span>
                        </>
                      )}
                    </span>
                    <button
                      type="button"
                      disabled={pending}
                      className={styles.quiet}
                      onClick={() => run(() => removeLink(e.from, e.to, e.type))}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <AddLink
          id={id}
          candidates={[...suggestions, ...neighbours.map((n) => ({ ...n, score: 0 }))]}
          pending={pending}
          onRun={run}
        />
      </section>

      {/* ── Suggestions ──────────────────────────────────────────────────── */}
      {suggestions.length > 0 && (
        <section className={ui.section}>
          <div className={ui.sectionHead}>
            <h2 className={ui.sectionTitle}>Might be related</h2>
          </div>
          <p className={ui.note}>
            Near this one but not linked. Each conversation is blind to the
            others, so these are the connections nothing has made yet.
          </p>
          <ul className={`${ui.list} stagger`} style={{ marginTop: "0.6rem" }}>
            {suggestions.map((s, i) => (
              <li key={s.id} style={{ "--i": Math.min(i, 14) } as React.CSSProperties}>
                <div className={ui.row}>
                  <Link href={`/c/${s.id}`} className={styles.linkTarget}>
                    {s.name}
                  </Link>
                  <span className={ui.datum}>{s.score.toFixed(2)}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── Delete ───────────────────────────────────────────────────────── */}
      <div className={styles.danger}>
        <button
          type="button"
          disabled={pending}
          className={styles.dangerButton}
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
        <span className={ui.note}>
          Reversible. Links survive. Permanent removal is a separate step on the
          trash page.
        </span>
      </div>
    </div>
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
    <div className={styles.addLink}>
      <select
        value={type}
        onChange={(e) => setType(e.target.value)}
        className={styles.input}
        aria-label="Relationship"
      >
        {REL_TYPES.map((t) => (
          <option key={t} value={t}>
            {relLabel(t)}
          </option>
        ))}
      </select>
      <select
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        className={`${styles.input} ${styles.grow}`}
        aria-label="Concept to link"
      >
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
        className={styles.primary}
        onClick={() => onRun(() => addLink(id, target, type))}
      >
        Link
      </button>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={styles.field}>
      <span className={styles.label}>{label}</span>
      {children}
      {hint && <span className={styles.hint}>{hint}</span>}
    </label>
  );
}

const splitList = (value: string) =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
