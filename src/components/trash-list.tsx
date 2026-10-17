"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { untrashConcept, destroyConcept, type ActionResult } from "@/app/actions";
import { relLabel } from "@/lib/rel-types";
import styles from "./trash-list.module.css";

interface TrashItem {
  id: string;
  name: string;
  deletedAt: string;
  edges: number;
  severs: Array<{ id: string; name: string; type: string }>;
}

/**
 * Restore, and the one irreversible action in the system.
 *
 * Destroying shows what it breaks before it offers the control that does it.
 * The note is one paragraph you could rewrite; the connections to it are the
 * thinking you cannot.
 */
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
        <p role="status" className={result.ok ? styles.ok : styles.bad}>
          {result.ok ? result.message : result.error}
        </p>
      )}

      <ul className={`${styles.list} stagger`}>
        {items.map((item, i) => (
          <li
            key={item.id}
            className={styles.item}
            style={{ "--i": Math.min(i, 14) } as React.CSSProperties}
          >
            <div className={styles.head}>
              <strong className={styles.name}>{item.name}</strong>
              <span className={styles.when}>
                {item.edges > 0 && (
                  <>
                    {item.edges} {item.edges === 1 ? "link" : "links"} kept ·{" "}
                  </>
                )}
                deleted <time dateTime={item.deletedAt}>{item.deletedAt.slice(0, 10)}</time>
              </span>
            </div>

            {confirming === item.id ? (
              <div className={styles.confirm}>
                {item.severs.length > 0 ? (
                  <p className={styles.impact}>
                    This also destroys {item.severs.length}{" "}
                    {item.severs.length === 1 ? "link" : "links"}, leaving{" "}
                    {item.severs.map((s, idx) => (
                      <span key={s.id}>
                        {idx > 0 && ", "}
                        <strong>{s.name}</strong>{" "}
                        <span className={styles.rel}>({relLabel(s.type)})</span>
                      </span>
                    ))}{" "}
                    without it.
                  </p>
                ) : (
                  <p className={styles.impact}>
                    Nothing links to this, so nothing else changes.
                  </p>
                )}

                <label className={styles.confirmLabel} htmlFor={`confirm-${item.id}`}>
                  Type <strong>{item.name}</strong> to confirm.
                </label>
                <div className={styles.confirmRow}>
                  <input
                    id={`confirm-${item.id}`}
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    autoFocus
                    autoComplete="off"
                    className={styles.input}
                  />
                  <button
                    type="button"
                    // The server checks this too. The guard cannot live only
                    // in a form, or a stray fetch would not have to pass it.
                    disabled={pending || typed.trim() !== item.name}
                    onClick={() => run(() => destroyConcept(item.id, typed))}
                    className={styles.destroy}
                  >
                    {pending ? "Destroying…" : "Destroy permanently"}
                  </button>
                  <button
                    type="button"
                    className={styles.quiet}
                    onClick={() => {
                      setConfirming(null);
                      setTyped("");
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className={styles.actions}>
                <button
                  type="button"
                  disabled={pending}
                  className={styles.restore}
                  onClick={() => run(() => untrashConcept(item.id))}
                >
                  Restore
                </button>
                <button
                  type="button"
                  disabled={pending}
                  className={styles.quiet}
                  onClick={() => {
                    setConfirming(item.id);
                    setTyped("");
                  }}
                >
                  Destroy permanently
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
