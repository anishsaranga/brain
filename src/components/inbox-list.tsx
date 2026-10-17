"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { discardInboxItem, type ActionResult } from "@/app/actions";
import styles from "./inbox-list.module.css";

interface Item {
  id: string;
  text: string;
  at: string;
}

/**
 * Captures, oldest first, each with a way out.
 *
 * Discard exists so a mis-captured note is not stuck in the inbox for ever.
 * Without it the only exit is extraction, which is the same "no exit" gap
 * that made the trash necessary, in miniature.
 */
export default function InboxList({ items }: { items: Item[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

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
            {/*
              Rendered as plain text with pre-wrap, not as markdown. A capture
              is whatever was pasted or dictated; treating it as markdown
              would silently reformat someone's raw note.
            */}
            <p className={styles.text}>{item.text}</p>
            <div className={styles.foot}>
              <time className={styles.when} dateTime={item.at}>
                captured {item.at.slice(0, 10)}
              </time>
              <button
                type="button"
                disabled={pending}
                className={styles.discard}
                onClick={() =>
                  start(async () => {
                    setResult(await discardInboxItem(item.id));
                    router.refresh();
                  })
                }
              >
                Discard
              </button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
