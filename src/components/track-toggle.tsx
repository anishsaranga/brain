"use client";

import { useState, useTransition } from "react";
import { trackConcept, type ActionResult } from "@/app/actions";
import styles from "./track-toggle.module.css";

/**
 * One click to put a note into spaced repetition, from wherever you are
 * reading it.
 *
 * Deliberately not `router.refresh()` after the write, which is what every
 * other small control in this app does. Those sit on short lists; this one
 * can appear forty times on a reading page, and refreshing re-runs the whole
 * walk and re-renders every markdown body to change one word. It holds its
 * own state and lets the server catch up on the next navigation, the same
 * trade the review session already makes when grading.
 *
 * The prompt field only ever appears after a successful enrol. Asking for a
 * question first would turn a one-click action into a writing task, and the
 * answer to "what should this ask me" is usually "the name is fine".
 */
export default function TrackToggle({
  id,
  tracked: initial,
  prompt: initialPrompt,
  size = "normal",
}: {
  id: string;
  tracked: boolean;
  prompt: string | null;
  /** `small` is for a row of notes, where the control must not outshout the title. */
  size?: "normal" | "small";
}) {
  const [tracked, setTracked] = useState(initial);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [asking, setAsking] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const apply = (next: boolean, withPrompt?: string | null, after?: () => void) =>
    start(async () => {
      setError(null);
      const result: ActionResult = await trackConcept(id, next, withPrompt);
      if (!result.ok) {
        // The optimistic state has already moved, so put it back.
        setTracked(!next);
        setError(result.error);
        return;
      }
      if (typeof withPrompt === "string" && withPrompt.trim() !== "") {
        setPrompt(withPrompt.trim());
      }
      after?.();
    });

  const toggle = () => {
    const next = !tracked;
    setTracked(next);
    // Offer a prompt only on the way in, and only when there is not one
    // already. Coming out of review is never the moment to write a question.
    setAsking(next && !prompt);
    apply(next);
  };

  return (
    <div className={size === "small" ? styles.smallRoot : styles.root}>
      <div className={styles.line}>
        <button
          type="button"
          disabled={pending}
          aria-pressed={tracked}
          className={tracked ? styles.on : styles.off}
          title={
            tracked
              ? "In spaced repetition. Click to take it out."
              : "Put this note into spaced repetition."
          }
          onClick={toggle}
        >
          {tracked ? "In review" : "Track"}
        </button>

        {tracked && prompt && !asking && (
          <button
            type="button"
            disabled={pending}
            className={styles.editPrompt}
            onClick={() => {
              setDraft(prompt);
              setAsking(true);
            }}
          >
            edit prompt
          </button>
        )}
      </div>

      {asking && (
        <div className={styles.ask}>
          <label className={styles.askLabel} htmlFor={`prompt-${id}`}>
            Ask this instead of the name
          </label>
          <div className={styles.askRow}>
            <input
              id={`prompt-${id}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Why does Raft need a majority?"
              className={styles.askInput}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  apply(true, draft, () => setAsking(false));
                }
                if (e.key === "Escape") setAsking(false);
              }}
            />
            <button
              type="button"
              disabled={pending || draft.trim() === ""}
              className={styles.askSave}
              onClick={() => apply(true, draft, () => setAsking(false))}
            >
              {pending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              disabled={pending}
              className={styles.askSkip}
              onClick={() => setAsking(false)}
            >
              Skip
            </button>
          </div>
          <p className={styles.askHint}>
            Optional. Without one, review asks you the note&rsquo;s name.
          </p>
        </div>
      )}

      {error && (
        <p role="status" className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}
