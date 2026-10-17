"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import {
  upsertConcept,
  renameConcept,
  linkConcepts,
  unlinkConcepts,
  softDeleteConcept,
  restoreConcept,
  hardDeleteConcept,
  setConceptFlags,
  isRelType,
  type RelType,
} from "@/lib/graph";
import { undoIngest, discardCapture } from "@/lib/ingest";
import { recordReview, GRADES, type Grade } from "@/lib/fsrs";

/**
 * Everything the explorer can change.
 *
 * Every action calls `requireUser()` first. Server actions are POST endpoints
 * reachable by anything that can construct the request, so the middleware
 * matcher is not the only thing standing between the internet and this
 * module.
 */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

function fail(error: string): ActionResult {
  return { ok: false, error };
}

export async function saveConcept(
  id: string,
  patch: { name?: string; body?: string; prompt?: string | null; aliases?: string[]; topics?: string[]; tracked?: boolean },
): Promise<ActionResult> {
  await requireUser();
  const name = patch.name?.trim();
  if (!name) return fail("A concept needs a name.");

  // Rename FIRST, keyed on the id.
  //
  // `upsertConcept` finds a concept by `nameLower` and ignores any id, so
  // passing it a changed name used to MERGE a brand new concept and leave
  // the original sitting there untouched: the edit disappeared and the graph
  // grew a silent duplicate. Moving the node to its new name first means the
  // upsert below then matches the concept actually being edited.
  const renamed = await renameConcept(id, name);
  if (!renamed.renamed) return fail(renamed.reason ?? "Could not rename that concept.");

  // `upsertConcept` REPLACES a supplied body, which is right here: this is a
  // deliberate edit, and the superseded version is kept as a revision. That
  // is the opposite of what a merge during ingest wants.
  await upsertConcept({
    name,
    body: patch.body,
    prompt: patch.prompt,
    aliases: patch.aliases,
    topics: patch.topics,
    tracked: patch.tracked,
  });

  revalidatePath(`/c/${id}`);
  revalidatePath("/");
  return { ok: true, message: "Saved." };
}

export async function addLink(
  fromId: string,
  toId: string,
  type: string,
  note?: string,
): Promise<ActionResult> {
  await requireUser();
  if (!isRelType(type)) return fail(`Unknown relationship type "${type}".`);
  if (fromId === toId) return fail("A concept cannot be linked to itself.");

  try {
    await linkConcepts(fromId, toId, type as RelType, { note });
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Could not add that link.");
  }
  revalidatePath(`/c/${fromId}`);
  revalidatePath(`/c/${toId}`);
  return { ok: true, message: "Linked." };
}

export async function removeLink(
  fromId: string,
  toId: string,
  type: string,
): Promise<ActionResult> {
  await requireUser();
  if (!isRelType(type)) return fail(`Unknown relationship type "${type}".`);

  const { removed } = await unlinkConcepts(fromId, toId, type as RelType);
  revalidatePath(`/c/${fromId}`);
  revalidatePath(`/c/${toId}`);
  return removed ? { ok: true, message: "Link removed." } : fail("That link no longer exists.");
}

export async function trashConcept(id: string): Promise<ActionResult> {
  await requireUser();
  const result = await softDeleteConcept(id);
  revalidatePath("/");
  revalidatePath("/trash");
  return result.deleted
    ? { ok: true, message: `"${result.name}" moved to trash. Its links survive.` }
    : fail("That concept is not here, or is already in the trash.");
}

export async function untrashConcept(id: string): Promise<ActionResult> {
  await requireUser();
  const result = await restoreConcept(id);
  revalidatePath("/");
  revalidatePath("/trash");
  return result.restored
    ? { ok: true, message: `"${result.name}" restored, with its links.` }
    : fail("That concept is not in the trash.");
}

/**
 * The only irreversible action in the system. Both guards live in
 * `hardDeleteConcept` rather than here: it must already be tombstoned, and
 * the typed name must match.
 */
export async function destroyConcept(id: string, confirmName: string): Promise<ActionResult> {
  await requireUser();
  const result = await hardDeleteConcept(id, confirmName);
  if (!result.deleted) return fail(result.reason ?? "Not destroyed.");

  revalidatePath("/");
  revalidatePath("/trash");
  return { ok: true, message: `"${result.name}" is gone for good.` };
}

/* ── The maintenance surfaces ──────────────────────────────────────────── */

/**
 * Reverse one ingest batch.
 *
 * `undoIngest` is idempotent and tombstones rather than destroys, so this is
 * safe to double-click and safe to regret: an undo issued by mistake leaves
 * everything restorable from /trash.
 */
export async function undoBatch(batchId: string): Promise<ActionResult> {
  await requireUser();
  const result = await undoIngest(batchId);
  if (!result.ok) return fail(result.note);

  revalidatePath("/");
  revalidatePath("/ingest");
  revalidatePath(`/ingest/${batchId}`);
  revalidatePath("/trash");
  return { ok: true, message: result.note };
}

/**
 * Drop a capture without extracting anything from it.
 *
 * Marks it processed rather than deleting it, consistent with everything
 * else here: the text stays on the node behind a `discardedAt`.
 */
export async function discardInboxItem(id: string): Promise<ActionResult> {
  await requireUser();
  const { discarded } = await discardCapture(id);
  revalidatePath("/inbox");
  return discarded
    ? { ok: true, message: "Discarded. It leaves the inbox but the text is kept." }
    : fail("That capture is not in the inbox, or has already been processed.");
}

/** Grade a card. The scheduling itself lives in `recordReview`. */
export async function gradeCard(id: string, grade: string): Promise<ActionResult> {
  await requireUser();
  if (!GRADES.includes(grade as Grade)) return fail(`Unknown grade "${grade}".`);

  const result = await recordReview(id, grade as Grade);
  if (!result.ok) return fail(result.reason);

  revalidatePath("/review");
  revalidatePath("/");
  return {
    ok: true,
    message: result.replayed
      ? "Already recorded."
      : `Next in ${result.intervalDays} ${result.intervalDays === 1 ? "day" : "days"}.`,
  };
}

/**
 * Mark a note wrong, from inside a review.
 *
 * Getting something wrong because the stored note is wrong is not a failure
 * of recall, and recording it as one would poison the schedule for a card
 * whose real problem is its content. This flags the note instead, and
 * /hygiene lists everything waiting to be fixed.
 */
export async function flagCard(id: string, note?: string): Promise<ActionResult> {
  await requireUser();
  const trimmed = note?.trim();
  const ok = await setConceptFlags(id, {
    flagged: true,
    flagNote: trimmed ? trimmed : null,
  });
  if (!ok) return fail("No concept with that id.");

  revalidatePath("/review");
  revalidatePath("/hygiene");
  revalidatePath(`/c/${id}`);
  return { ok: true, message: "Flagged for a fix. It stays in the queue." };
}

/** Clear a flag once the note has been corrected. */
export async function unflagConcept(id: string): Promise<ActionResult> {
  await requireUser();
  const ok = await setConceptFlags(id, { flagged: false, flagNote: null });
  if (!ok) return fail("No concept with that id.");

  revalidatePath("/hygiene");
  revalidatePath(`/c/${id}`);
  return { ok: true, message: "Flag cleared." };
}
