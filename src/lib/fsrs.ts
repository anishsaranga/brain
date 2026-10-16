import {
  fsrs,
  generatorParameters,
  createEmptyCard,
  Rating,
  State,
  type Card,
  type Grade as FsrsGrade,
} from "ts-fsrs";
import { read, write, int } from "@/lib/neo4j";

/**
 * Spaced repetition over Concept properties.
 *
 * Two rules from the design drive everything here:
 *
 * 1. **Storage and rehearsal are separate opt-ins.** A concept in the graph is
 *    not a flashcard. Only `tracked` concepts enter this queue, and nothing
 *    enrols itself — most of what lands in a second brain is reference
 *    material you want to *find*, not memorise, and conflating the two is what
 *    makes these systems unbearable by week three.
 * 2. **Daily caps, from the start.** Without them week three delivers "400
 *    due", the tab closes, and the project is over. This is the single most
 *    likely way the whole thing fails, so the caps are not configurable-later.
 */

export const DEFAULT_NEW_PER_DAY = 10;
export const DEFAULT_REVIEWS_PER_DAY = 60;

/** Grades as Claude and the UI name them. */
export const GRADES = ["again", "hard", "good", "easy"] as const;
export type Grade = (typeof GRADES)[number];

// Typed as FsrsGrade rather than Rating: ts-fsrs excludes Rating.Manual from
// what `next` accepts, and the four grades here are exactly that subset.
const RATING: Record<Grade, FsrsGrade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

/** `state` is stored as a readable string; ts-fsrs wants the enum. */
const STATE_TO_NUM: Record<string, State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
};
const NUM_TO_STATE: Record<number, string> = {
  [State.New]: "new",
  [State.Learning]: "learning",
  [State.Review]: "review",
  [State.Relearning]: "relearning",
};

const scheduler = fsrs(generatorParameters({ enable_fuzz: true }));

export interface ConceptCardProps {
  state?: string | null;
  stability?: number | null;
  difficulty?: number | null;
  due?: string | null;
  lastReview?: string | null;
  reps?: number | null;
  lapses?: number | null;
  elapsedDays?: number | null;
  scheduledDays?: number | null;
  learningSteps?: number | null;
}

export function cardFromConcept(props: ConceptCardProps, now = new Date()): Card {
  if (!props.due || !props.state || props.state === "new") {
    return createEmptyCard(now);
  }
  return {
    due: new Date(props.due),
    stability: props.stability ?? 0,
    difficulty: props.difficulty ?? 0,
    elapsed_days: props.elapsedDays ?? 0,
    scheduled_days: props.scheduledDays ?? 0,
    learning_steps: props.learningSteps ?? 0,
    reps: props.reps ?? 0,
    lapses: props.lapses ?? 0,
    state: STATE_TO_NUM[props.state] ?? State.New,
    last_review: props.lastReview ? new Date(props.lastReview) : undefined,
  };
}

/** The property map to write back after a grading. */
export function conceptPropsFromCard(card: Card): Record<string, unknown> {
  return {
    state: NUM_TO_STATE[card.state] ?? "new",
    stability: card.stability,
    difficulty: card.difficulty,
    due: card.due.toISOString(),
    lastReview: card.last_review ? card.last_review.toISOString() : null,
    reps: card.reps,
    lapses: card.lapses,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
  };
}

export function schedule(card: Card, grade: Grade, now = new Date()): Card {
  return scheduler.next(card, now, RATING[grade]).card;
}

/**
 * Reviews and new cards already introduced today, in the container's local
 * timezone.
 *
 * Local, not UTC: "what is due today" is a human question, and compose sets TZ
 * for exactly this reason. On UTC the day would roll over mid-evening and the
 * caps would reset at the wrong moment.
 */
export async function todayCounts(): Promise<{ reviews: number; introduced: number }> {
  const result = await read(`
    MATCH (c:Concept)
    WHERE c.deletedAt IS NULL
      AND c.lastReview IS NOT NULL
      AND date(c.lastReview) = date()
    RETURN count(c) AS reviews,
           count(CASE WHEN c.reps = 1 THEN 1 END) AS introduced
  `);
  const r = result.records[0];
  return {
    reviews: r?.get("reviews")?.toNumber?.() ?? 0,
    introduced: r?.get("introduced")?.toNumber?.() ?? 0,
  };
}

export interface DueCard {
  id: string;
  name: string;
  prompt: string | null;
  body: string;
  state: string;
  due: string | null;
  reps: number;
  lapses: number;
}

export interface DueQueue {
  cards: DueCard[];
  /** Total tracked concepts actually due, before caps. */
  totalDue: number;
  newToday: number;
  reviewsToday: number;
  /** Set when the cap, not the queue, is why fewer cards came back. */
  cappedBy: "reviews" | "new" | null;
  note: string;
}

/**
 * The review queue: tracked, not deleted, due now, respecting daily caps.
 *
 * Reports `totalDue` and `cappedBy` rather than just returning a short list,
 * because a caller that gets 0 cards needs to know whether it is "nothing to
 * do" or "you have done enough today" — those mean completely different things
 * and silently conflating them would make the caps feel like a bug.
 */
export async function dueForReview(
  limit = 20,
  {
    newPerDay = DEFAULT_NEW_PER_DAY,
    reviewsPerDay = DEFAULT_REVIEWS_PER_DAY,
  }: { newPerDay?: number; reviewsPerDay?: number } = {},
): Promise<DueQueue> {
  const { reviews, introduced } = await todayCounts();
  const remainingReviews = Math.max(0, reviewsPerDay - reviews);
  const remainingNew = Math.max(0, newPerDay - introduced);

  const totalResult = await read(`
    MATCH (c:Concept)
    WHERE c.deletedAt IS NULL AND c.tracked = true
      AND (c.due IS NULL OR c.due <= datetime())
    RETURN count(c) AS n
  `);
  const totalDue = totalResult.records[0]?.get("n")?.toNumber?.() ?? 0;

  const take = Math.max(0, Math.min(limit, remainingReviews));
  let cappedBy: DueQueue["cappedBy"] = null;
  if (remainingReviews === 0 && totalDue > 0) cappedBy = "reviews";

  const cards: DueCard[] = [];
  if (take > 0) {
    const result = await read(
      `
      MATCH (c:Concept)
      WHERE c.deletedAt IS NULL AND c.tracked = true
        AND (c.due IS NULL OR c.due <= datetime())
      // Cards already in rotation first: finishing what you started beats
      // starting more, and new cards are separately capped below.
      WITH c, CASE WHEN coalesce(c.reps, 0) = 0 THEN 1 ELSE 0 END AS isNew
      ORDER BY isNew ASC, c.due ASC
      RETURN c.id AS id, c.name AS name, c.prompt AS prompt, c.body AS body,
             coalesce(c.state, 'new') AS state, c.due AS due,
             coalesce(c.reps, 0) AS reps, coalesce(c.lapses, 0) AS lapses,
             isNew
      LIMIT $take
      `,
      { take: int(take) },
    );

    let newTaken = 0;
    for (const rec of result.records) {
      const isNew = (rec.get("isNew")?.toNumber?.() ?? 0) === 1;
      if (isNew) {
        if (newTaken >= remainingNew) {
          cappedBy = cappedBy ?? "new";
          continue;
        }
        newTaken++;
      }
      cards.push({
        id: String(rec.get("id")),
        name: String(rec.get("name")),
        prompt: (rec.get("prompt") as string | null) ?? null,
        body: (rec.get("body") as string) ?? "",
        state: String(rec.get("state")),
        due: rec.get("due") ? String(rec.get("due")) : null,
        reps: rec.get("reps")?.toNumber?.() ?? 0,
        lapses: rec.get("lapses")?.toNumber?.() ?? 0,
      });
    }
  }

  const note =
    totalDue === 0
      ? "Nothing is due. This is a normal state, not an error."
      : cappedBy === "reviews"
        ? `${totalDue} due, but today's review cap of ${reviewsPerDay} is reached. More tomorrow.`
        : cappedBy === "new"
          ? `Today's limit of ${newPerDay} new cards is reached; only cards already in rotation are shown.`
          : `${cards.length} of ${totalDue} due.`;

  return { cards, totalDue, newToday: introduced, reviewsToday: reviews, cappedBy, note };
}

/**
 * Grade a card.
 *
 * Refuses untracked concepts rather than enrolling them: silently turning
 * something into a flashcard because it was graded once would violate the
 * separate-opt-in rule, and would be invisible until the queue filled up.
 *
 * A repeat of the same grade within `idempotencyWindowMs` is treated as a
 * retry and returns the existing state. Claude retries on timeout, and
 * applying the same grading twice would advance the schedule twice.
 */
export async function recordReview(
  id: string,
  grade: Grade,
  { now = new Date(), idempotencyWindowMs = 30_000 } = {},
): Promise<
  | { ok: true; replayed: boolean; state: string; due: string; intervalDays: number }
  | { ok: false; reason: string }
> {
  const existing = await read(
    `
    MATCH (c:Concept {id: $id})
    RETURN c.deletedAt AS deletedAt, c.tracked AS tracked, c.state AS state,
           c.stability AS stability, c.difficulty AS difficulty, c.due AS due,
           c.lastReview AS lastReview, c.reps AS reps, c.lapses AS lapses,
           c.elapsedDays AS elapsedDays, c.scheduledDays AS scheduledDays,
           c.learningSteps AS learningSteps, c.lastGrade AS lastGrade
    `,
    { id },
  );
  const rec = existing.records[0];
  if (!rec) return { ok: false, reason: `No concept with id ${id}.` };
  if (rec.get("deletedAt")) return { ok: false, reason: "That concept is deleted." };
  if (!rec.get("tracked")) {
    return {
      ok: false,
      reason:
        "That concept is not tracked for review. Storage and rehearsal are " +
        "separate here — call update_concept with {tracked: true} first if " +
        "you want it in the queue.",
    };
  }

  const lastReview = rec.get("lastReview") ? new Date(String(rec.get("lastReview"))) : null;
  const lastGrade = rec.get("lastGrade") as string | null;
  if (
    lastReview &&
    lastGrade === grade &&
    now.getTime() - lastReview.getTime() < idempotencyWindowMs
  ) {
    return {
      ok: true,
      replayed: true,
      state: String(rec.get("state") ?? "new"),
      due: String(rec.get("due") ?? ""),
      intervalDays: 0,
    };
  }

  const num = (v: unknown) =>
    v && typeof (v as { toNumber?: () => number }).toNumber === "function"
      ? (v as { toNumber: () => number }).toNumber()
      : (v as number | null);

  const card = cardFromConcept(
    {
      state: rec.get("state") as string | null,
      stability: num(rec.get("stability")),
      difficulty: num(rec.get("difficulty")),
      due: rec.get("due") ? String(rec.get("due")) : null,
      lastReview: lastReview ? lastReview.toISOString() : null,
      reps: num(rec.get("reps")),
      lapses: num(rec.get("lapses")),
      elapsedDays: num(rec.get("elapsedDays")),
      scheduledDays: num(rec.get("scheduledDays")),
      learningSteps: num(rec.get("learningSteps")),
    },
    now,
  );

  const next = schedule(card, grade, now);
  const props = conceptPropsFromCard(next);

  await write(
    `
    MATCH (c:Concept {id: $id})
    SET c.state         = $state,
        c.stability     = $stability,
        c.difficulty    = $difficulty,
        c.due           = datetime($due),
        c.lastReview    = datetime($lastReview),
        c.reps          = $reps,
        c.lapses        = $lapses,
        c.elapsedDays   = $elapsedDays,
        c.scheduledDays = $scheduledDays,
        c.learningSteps = $learningSteps,
        c.lastGrade     = $grade
    `,
    {
      id,
      ...props,
      // reps/lapses/day-counts must land as Neo4j INTEGERS. A plain JS number
      // is sent as Float64, so `reps` would come back as 1.0 and any reader
      // calling toNumber() on it breaks.
      reps: int(Number(props.reps)),
      lapses: int(Number(props.lapses)),
      elapsedDays: int(Number(props.elapsedDays)),
      scheduledDays: int(Number(props.scheduledDays)),
      learningSteps: int(Number(props.learningSteps)),
      lastReview: props.lastReview ?? now.toISOString(),
      grade,
    },
  );

  const intervalDays = Math.max(
    0,
    Math.round((next.due.getTime() - now.getTime()) / 86_400_000),
  );
  return {
    ok: true,
    replayed: false,
    state: String(props.state),
    due: String(props.due),
    intervalDays,
  };
}
