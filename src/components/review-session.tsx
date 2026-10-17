"use client";

import { useState, useTransition, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { gradeCard, flagCard, type ActionResult } from "@/app/actions";
import Markdown from "./markdown";
import styles from "./review-session.module.css";

interface Card {
  id: string;
  name: string;
  prompt: string | null;
  body: string;
  state: string;
  reps: number;
  lapses: number;
}

const GRADES = [
  { key: "again", label: "Again", hint: "No recall", digit: "1" },
  { key: "hard", label: "Hard", hint: "Came slowly", digit: "2" },
  { key: "good", label: "Good", hint: "Recalled it", digit: "3" },
  { key: "easy", label: "Easy", hint: "Instant", digit: "4" },
] as const;

/**
 * One card at a time: prompt, reveal, grade.
 *
 * The queue is held here and advanced locally rather than re-fetched per
 * card. A round trip between every answer makes a twenty card session feel
 * like work, and the scheduling write does not need to be awaited before
 * showing the next prompt.
 */
export default function ReviewSession({
  cards,
  totalDue,
}: {
  cards: Card[];
  totalDue: number;
}) {
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [flagging, setFlagging] = useState(false);
  const [flagNote, setFlagNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();

  const card = cards[index];
  const done = index >= cards.length;

  const advance = useCallback(() => {
    setRevealed(false);
    setFlagging(false);
    setFlagNote("");
    setIndex((i) => i + 1);
  }, []);

  const grade = useCallback(
    (value: string) => {
      if (!card) return;
      const id = card.id;
      advance();
      // Fired without blocking the next prompt. A failure surfaces on the
      // next render rather than stalling the session.
      start(async () => {
        const result: ActionResult = await gradeCard(id, value);
        if (!result.ok) setError(result.error);
      });
    },
    [card, advance],
  );

  // Keyboard: space to reveal, 1-4 to grade. A review session is the one
  // place in this app where the hands should not have to leave the keyboard.
  useEffect(() => {
    if (done) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if (!revealed && (e.key === " " || e.key === "Enter")) {
        e.preventDefault();
        setRevealed(true);
        return;
      }
      if (revealed) {
        const hit = GRADES.find((g) => g.digit === e.key);
        if (hit) {
          e.preventDefault();
          grade(hit.key);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [revealed, done, grade]);

  if (done) {
    return (
      <div className={styles.finished}>
        <h1 className={styles.finishedTitle}>Session complete</h1>
        <p className={styles.finishedLead}>
          {cards.length} {cards.length === 1 ? "card" : "cards"} reviewed.
          {totalDue > cards.length && ` ${totalDue - cards.length} still due.`}
        </p>
        <div className={styles.finishedActions}>
          {totalDue > cards.length && (
            <button type="button" className={styles.primary} onClick={() => router.refresh()}>
              Keep going
            </button>
          )}
          <Link href="/" className={styles.secondary}>
            Back to overview
          </Link>
        </div>
        {error && <p className={styles.error}>{error}</p>}
      </div>
    );
  }

  const progress = Math.round((index / cards.length) * 100);

  return (
    <div className={styles.wrap}>
      <div className={styles.progressRow}>
        <span className={styles.counter}>
          {index + 1} / {cards.length}
        </span>
        <div
          className={styles.track}
          role="progressbar"
          aria-valuenow={index}
          aria-valuemin={0}
          aria-valuemax={cards.length}
        >
          <div className={styles.fill} style={{ width: `${progress}%` }} />
        </div>
        {card.lapses > 0 && (
          <span className={styles.lapses} title="Times this card has been forgotten">
            {card.lapses} {card.lapses === 1 ? "lapse" : "lapses"}
          </span>
        )}
      </div>

      {error && <p className={styles.error}>{error}</p>}

      <article className={styles.card} key={card.id}>
        <h1 className={styles.prompt}>{card.prompt ?? card.name}</h1>

        {revealed ? (
          <div className={styles.answer}>
            {/* The prompt may be a question, in which case the name is part
                of the answer rather than something already on screen. */}
            {card.prompt && <p className={styles.answerName}>{card.name}</p>}
            {card.body.trim() ? (
              <Markdown>{card.body}</Markdown>
            ) : (
              <p className={styles.blank}>This concept has no note yet.</p>
            )}
          </div>
        ) : (
          <button type="button" className={styles.reveal} onClick={() => setRevealed(true)}>
            Show answer <kbd className={styles.kbd}>space</kbd>
          </button>
        )}
      </article>

      {revealed && (
        <>
          <div className={styles.grades}>
            {GRADES.map((g) => (
              <button
                key={g.key}
                type="button"
                className={styles.grade}
                onClick={() => grade(g.key)}
              >
                <span className={styles.gradeLabel}>{g.label}</span>
                <span className={styles.gradeHint}>{g.hint}</span>
                <kbd className={styles.kbd}>{g.digit}</kbd>
              </button>
            ))}
          </div>

          {/*
            Getting it wrong because the note is wrong is not a failure of
            recall, and grading it "again" would poison the schedule for a
            card whose real problem is its content.
          */}
          <div className={styles.footer}>
            {flagging ? (
              <div className={styles.flagForm}>
                <input
                  value={flagNote}
                  onChange={(e) => setFlagNote(e.target.value)}
                  placeholder="What is wrong with it? (optional)"
                  className={styles.flagInput}
                  autoFocus
                />
                <button
                  type="button"
                  className={styles.flagConfirm}
                  onClick={() => {
                    const id = card.id;
                    const note = flagNote;
                    advance();
                    start(async () => {
                      const result = await flagCard(id, note);
                      if (!result.ok) setError(result.error);
                    });
                  }}
                >
                  Flag and skip
                </button>
                <button
                  type="button"
                  className={styles.quiet}
                  onClick={() => setFlagging(false)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className={styles.quiet}
                  onClick={() => setFlagging(true)}
                >
                  The note is wrong
                </button>
                <Link href={`/c/${card.id}`} className={styles.quietLink}>
                  Open concept
                </Link>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
