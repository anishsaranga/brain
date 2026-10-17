"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { undoBatch, type ActionResult } from "@/app/actions";
import styles from "./undo-batch.module.css";

/**
 * Reverse a whole ingest.
 *
 * Two clicks, but no typed confirmation, and the asymmetry is deliberate:
 * this is reversible. Concepts the batch created are tombstoned rather than
 * destroyed and merged bodies are restored from the record written before
 * the merge, so an undo issued by mistake is itself undoable from /trash.
 * Typing a name to confirm belongs on the one action that is not.
 */
export default function UndoBatch({ batchId }: { batchId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [armed, setArmed] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);

  if (result?.ok) {
    return (
      <span role="status" className={styles.done}>
        {result.message}
      </span>
    );
  }

  return (
    <span className={styles.wrap}>
      {result && !result.ok && (
        <span role="alert" className={styles.error}>
          {result.error}
        </span>
      )}

      {armed ? (
        <>
          <button
            type="button"
            disabled={pending}
            className={styles.confirm}
            onClick={() =>
              start(async () => {
                setResult(await undoBatch(batchId));
                setArmed(false);
                router.refresh();
              })
            }
          >
            {pending ? "Reversing…" : "Yes, reverse it"}
          </button>
          <button type="button" className={styles.quiet} onClick={() => setArmed(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button type="button" className={styles.button} onClick={() => setArmed(true)}>
          Undo this batch
        </button>
      )}
    </span>
  );
}
