import { randomUUID } from "node:crypto";
import { read, write } from "@/lib/neo4j";
import { embed, embeddingText } from "@/lib/embeddings";
import {
  upsertConcept,
  linkConcepts,
  findSimilar,
  isRelType,
  REL_TYPES,
  type RelType,
} from "@/lib/graph";

/**
 * The write path: batches, the three-state handshake, and undo.
 *
 * Everything here exists because this is the surface a language model drives
 * over a public endpoint, against data that cannot be rebuilt from a repo.
 */

/**
 * Hard limits on one call.
 *
 * Two jobs. They bound what a single injected instruction can do, and they
 * protect the process: embedding runs in-process and CPU-bound, so a
 * 300-concept call would pin the container long enough to fail its own
 * healthcheck. Exceeding a cap is a rejection with a clear message, never a
 * silent truncation — quietly dropping half a knowledge write is data loss.
 */
export const CAPS = {
  concepts: 30,
  links: 100,
  bodyChars: 50_000,
  totalChars: 200_000,
  inbox: 50,
};

/**
 * Cosine similarity at or above which a new concept is treated as ambiguous
 * rather than created.
 *
 * One threshold, not two. Auto-merging on similarity alone is exactly the
 * judgement the server must not make: it has no way to know whether "Leader
 * election" and "Leader election in Raft" are the same idea, and guessing
 * wrong either destroys a distinction or duplicates a concept. Above this
 * line it asks; below it, it creates.
 *
 * 0.80 is measured, not guessed. Against a real graph with this model:
 *
 *   WAL              <-> Write-ahead logging   0.835   same thing, must ask
 *   Write-ahead log  <-> Write-ahead logging   0.992   same thing, must ask
 *   Write-ahead logging <-> Crash recovery     0.750   related, genuinely distinct
 *   Backpressure     <-> anything unrelated    0.55-0.58
 *
 * An earlier 0.85 sat just above the acronym case and let "WAL" through as a
 * new concept — and acronym/full-name pairs are among the most common
 * duplicates in technical notes. 0.80 lands between "related but distinct" and
 * "actually the same". Erring low is the right direction: a false positive
 * costs one extra round trip, a false negative is a silent duplicate that
 * splits a concept's links in half forever.
 */
export const AMBIGUITY_THRESHOLD = 0.8;

export interface RememberConcept {
  name: string;
  body?: string;
  aliases?: string[];
  topics?: string[];
  prompt?: string;
  /**
   * Enrol in spaced repetition. Storing something does not track it, so
   * without this field enrolling takes a second `update_concept` call that
   * in practice never happens.
   *
   * Only `true` has any effect here: `false` means "no opinion", never
   * "untrack". A later conversation mentioning a concept in passing must
   * not silently drop it out of review — the same reasoning that makes a
   * merge append to a body rather than replace it. Untracking is
   * `update_concept`'s job, where it is the explicit point of the call.
   */
  tracked?: boolean;
}

export interface RememberLink {
  /** Name, alias or id. Resolved after the concepts are written. */
  from: string;
  to: string;
  type: RelType;
  note?: string;
  weight?: number;
}

export interface Decision {
  /** The concept name from `concepts` this decision resolves. */
  name: string;
  action: "merge" | "new";
  /** Required for "merge": which existing concept to merge into. */
  mergeIntoId?: string;
}

export interface RememberInput {
  concepts: RememberConcept[];
  links?: RememberLink[];
  source?: { kind: string; ref?: string; title?: string };
  decisions?: Decision[];
  consumesInbox?: string[];
  idempotencyKey?: string;
  toolCaller?: string;
}

export interface ConceptOutcome {
  name: string;
  status: "created" | "merged" | "ambiguous" | "rejected";
  id?: string;
  candidates?: Array<{ id: string; name: string; score: number }>;
  reason?: string;
}

export interface RememberResult {
  batchId: string | null;
  reviewUrl: string | null;
  replayed: boolean;
  counts: { created: number; merged: number; ambiguous: number; rejected: number };
  concepts: ConceptOutcome[];
  links: { written: number; skipped: Array<RememberLink & { reason: string }> };
  /** Nearest existing concepts not yet linked — the orphan-islands defence. */
  suggestions: Array<{
    id: string;
    name: string;
    candidates: Array<{ id: string; name: string; score: number }>;
  }>;
  inboxCleared: number;
  note?: string;
}

function baseUrl(): string {
  return (process.env.PUBLIC_BASE_URL ?? "http://localhost:9999").replace(/\/+$/, "");
}

export class CapExceededError extends Error {}

// ── The inbox ────────────────────────────────────────────────────────────────
//
// Capture and extraction are different acts at different moments. You meet an
// idea while doing something else and have neither the time nor the context to
// decide what the concepts are, what they are called, or what they link to —
// and forcing that decision then is how capture stops happening at all.
//
// So the inbox holds raw text with no structure and no embedding, and
// `remember({consumesInbox})` clears it in the same transaction as the write
// it produced.

export interface CaptureResult {
  id: string;
  /** Unprocessed items now waiting, so a growing backlog is visible. */
  backlog: number;
}

export interface CaptureSource {
  kind: string;
  ref?: string;
  title?: string;
}

export async function capture(
  text: string,
  source?: CaptureSource,
): Promise<CaptureResult> {
  const trimmed = (text ?? "").trim();
  if (!trimmed) throw new Error("Nothing to capture: the text is empty.");
  if (trimmed.length > CAPS.bodyChars) {
    throw new CapExceededError(
      `Capture is ${trimmed.length} characters; the limit is ${CAPS.bodyChars}. ` +
        `Nothing has been written. Split it, or extract concepts directly with remember.`,
    );
  }

  const result = await write(
    `
    CREATE (b:Inbox {
      id: randomUUID(),
      text: $text,
      at: datetime(),
      processed: false,
      sourceKind: $kind,
      sourceRef: $ref,
      sourceTitle: $title
    })
    RETURN b.id AS id
    `,
    {
      text: trimmed,
      kind: source?.kind ?? null,
      ref: source?.ref ?? null,
      title: source?.title ?? null,
    },
  );

  const backlog = await read(
    "MATCH (b:Inbox) WHERE coalesce(b.processed, false) = false RETURN count(b) AS n",
  );

  return {
    id: String(result.records[0]?.get("id")),
    backlog: backlog.records[0]?.get("n")?.toNumber?.() ?? 0,
  };
}

/**
 * Drop a capture without extracting anything from it.
 *
 * Without this a mis-captured note can never leave the inbox, since the only
 * other exit is `remember({consumesInbox})`, which requires concepts. It
 * marks rather than destroys, like everything else reachable over MCP.
 */
export async function discardCapture(id: string): Promise<{ discarded: boolean }> {
  const result = await write(
    `
    MATCH (b:Inbox {id: $id})
    WHERE coalesce(b.processed, false) = false
    SET b.processed = true, b.discardedAt = datetime()
    RETURN b.id AS id
    `,
    { id },
  );
  return { discarded: result.records.length > 0 };
}

function enforceCaps(input: RememberInput): void {
  const concepts = input.concepts ?? [];
  const links = input.links ?? [];

  if (concepts.length === 0 && links.length === 0) {
    throw new CapExceededError("Nothing to write: concepts and links are both empty.");
  }
  if (concepts.length > CAPS.concepts) {
    throw new CapExceededError(
      `${concepts.length} concepts in one call; the limit is ${CAPS.concepts}. ` +
        `Split it into several calls — nothing has been written.`,
    );
  }
  if (links.length > CAPS.links) {
    throw new CapExceededError(
      `${links.length} links in one call; the limit is ${CAPS.links}. Nothing has been written.`,
    );
  }
  if ((input.consumesInbox?.length ?? 0) > CAPS.inbox) {
    throw new CapExceededError(`Too many inbox items in one call; the limit is ${CAPS.inbox}.`);
  }

  let total = 0;
  for (const c of concepts) {
    const len = (c.body ?? "").length;
    if (len > CAPS.bodyChars) {
      throw new CapExceededError(
        `The body for "${c.name}" is ${len} characters; the limit is ` +
          `${CAPS.bodyChars}. A concept should be one idea you could explain ` +
          `in a paragraph. Nothing has been written.`,
      );
    }
    total += len + c.name.length;
  }
  if (total > CAPS.totalChars) {
    throw new CapExceededError(
      `Payload is ${total} characters; the limit is ${CAPS.totalChars}. Nothing has been written.`,
    );
  }

  for (const link of links) {
    if (!isRelType(link.type)) {
      throw new CapExceededError(
        `"${link.type}" is not a relationship type. Use one of: ${REL_TYPES.join(", ")}. ` +
          `Nothing has been written.`,
      );
    }
  }
}

/** Existing concept matching this name or one of its aliases, case-insensitively. */
async function findExact(
  name: string,
): Promise<{ id: string; name: string } | null> {
  const lower = name.trim().toLocaleLowerCase();
  const result = await read(
    `
    MATCH (c:Concept)
    WHERE c.deletedAt IS NULL
      AND (c.nameLower = $lower
           OR $lower IN [a IN coalesce(c.aliases, []) | toLower(a)])
    RETURN c.id AS id, c.name AS name
    LIMIT 1
    `,
    { lower },
  );
  const rec = result.records[0];
  return rec ? { id: String(rec.get("id")), name: String(rec.get("name")) } : null;
}

export async function remember(input: RememberInput): Promise<RememberResult> {
  enforceCaps(input);

  // Replay rather than re-run. Claude retries on timeout, and a second run
  // would create a second Ingest batch that undo could only half-reverse.
  if (input.idempotencyKey) {
    const prior = await read(
      "MATCH (i:Ingest {idempotencyKey: $key}) RETURN i.resultJson AS json LIMIT 1",
      { key: input.idempotencyKey },
    );
    const json = prior.records[0]?.get("json") as string | undefined;
    if (json) {
      try {
        return { ...(JSON.parse(json) as RememberResult), replayed: true };
      } catch {
        // Fall through and do the work rather than fail on a corrupt record.
      }
    }
  }

  const decisions = new Map(
    (input.decisions ?? []).map((d) => [d.name.trim().toLocaleLowerCase(), d]),
  );

  // ── Resolve each concept before writing anything ───────────────────────────
  const outcomes: ConceptOutcome[] = [];
  const toWrite: Array<{ input: RememberConcept; status: "created" | "merged" }> = [];

  for (const concept of input.concepts ?? []) {
    const name = (concept.name ?? "").trim();
    if (!name) {
      outcomes.push({ name: concept.name ?? "", status: "rejected", reason: "Empty name." });
      continue;
    }

    const decision = decisions.get(name.toLocaleLowerCase());

    const exact = await findExact(name);
    if (exact) {
      toWrite.push({ input: { ...concept, name: exact.name }, status: "merged" });
      outcomes.push({ name, status: "merged", id: exact.id });
      continue;
    }

    if (decision?.action === "new") {
      toWrite.push({ input: concept, status: "created" });
      outcomes.push({ name, status: "created" });
      continue;
    }

    if (decision?.action === "merge") {
      if (!decision.mergeIntoId) {
        outcomes.push({
          name,
          status: "rejected",
          reason: 'A "merge" decision needs mergeIntoId.',
        });
        continue;
      }
      const target = await read(
        "MATCH (c:Concept {id: $id}) WHERE c.deletedAt IS NULL RETURN c.name AS name",
        { id: decision.mergeIntoId },
      );
      const targetName = target.records[0]?.get("name") as string | undefined;
      if (!targetName) {
        outcomes.push({
          name,
          status: "rejected",
          reason: `No live concept with id ${decision.mergeIntoId}.`,
        });
        continue;
      }
      // Merge = write into the existing concept under its own name, carrying
      // this name across as an alias so the lookup that found it keeps working.
      toWrite.push({
        input: {
          ...concept,
          name: targetName,
          aliases: [...new Set([...(concept.aliases ?? []), name])],
        },
        status: "merged",
      });
      outcomes.push({ name, status: "merged", id: decision.mergeIntoId });
      continue;
    }

    // No exact match and no decision: is it close enough to something to be a
    // judgement call? If so, write nothing and ask.
    const vector = await embed(
      embeddingText({ name, aliases: concept.aliases, body: concept.body }),
    );
    const similar = await findSimilar(vector, { limit: 3, minScore: AMBIGUITY_THRESHOLD });
    if (similar.length > 0) {
      outcomes.push({
        name,
        status: "ambiguous",
        candidates: similar.map((s) => ({
          id: s.id,
          name: s.name,
          score: Math.round(s.score * 1000) / 1000,
        })),
        reason:
          "Too similar to something already in the graph to decide safely. " +
          "Call remember again with decisions: [{name, action: 'merge', " +
          "mergeIntoId}] or [{name, action: 'new'}].",
      });
      continue;
    }

    toWrite.push({ input: concept, status: "created" });
    outcomes.push({ name, status: "created" });
  }

  // Partial success is the point: five good concepts and one ambiguous means
  // the five land. Rejecting the batch would throw away a conversation's worth
  // of knowledge over one fuzzy match, and the retry would have to resend it.
  const batchId = randomUUID();
  const hasWrites = toWrite.length > 0;

  if (!hasWrites) {
    return {
      batchId: null,
      reviewUrl: null,
      replayed: false,
      counts: tally(outcomes),
      concepts: outcomes,
      links: { written: 0, skipped: (input.links ?? []).map((l) => ({ ...l, reason: "No concepts were written." })) },
      suggestions: [],
      inboxCleared: 0,
      note: "Nothing was written — every concept needs a decision first.",
    };
  }

  // ── Record the batch before writing, so undo is exact ──────────────────────
  // The prior body and aliases of anything being merged go on the Ingest node
  // itself. Reconstructing them afterwards from the concept is impossible,
  // because the merge has already overwritten them.
  const mergedPrior: string[] = [];
  const priorBodyByName = new Map<string, string>();
  for (const item of toWrite) {
    if (item.status !== "merged") continue;
    const prior = await read(
      `MATCH (c:Concept) WHERE c.nameLower = $lower
       RETURN c.id AS id, c.body AS body, c.aliases AS aliases`,
      { lower: item.input.name.toLocaleLowerCase() },
    );
    const rec = prior.records[0];
    if (rec) {
      const body = (rec.get("body") as string) ?? "";
      priorBodyByName.set(item.input.name.toLocaleLowerCase(), body);
      mergedPrior.push(
        JSON.stringify({
          id: String(rec.get("id")),
          body,
          aliases: (rec.get("aliases") as string[]) ?? [],
        }),
      );
    }
  }

  await write(
    `
    CREATE (i:Ingest {
      id: $id, at: datetime(), summary: $summary, toolCaller: $toolCaller,
      undone: false, idempotencyKey: $key, mergedPrior: $mergedPrior,
      createdIds: [], mergedIds: [], createdEdges: []
    })
    `,
    {
      id: batchId,
      summary: `${toWrite.length} concept(s)`,
      toolCaller: input.toolCaller ?? "mcp",
      key: input.idempotencyKey ?? null,
      mergedPrior,
    },
  );

  // ── Write the concepts ─────────────────────────────────────────────────────
  const nameToId = new Map<string, string>();
  const createdIds: string[] = [];
  const mergedIds: string[] = [];

  for (let i = 0; i < toWrite.length; i++) {
    const item = toWrite[i];
    const result = await upsertConcept({
      name: item.input.name,
      aliases: item.input.aliases,
      // A MERGE APPENDS. `upsertConcept` replaces a supplied body, which is
      // right for update_concept (a deliberate edit, with the old version kept
      // as a revision) and wrong here: a later conversation mentioning a
      // concept in passing must not wipe what an earlier one wrote. The two
      // write paths want opposite semantics, so the appending happens here
      // rather than being baked into the shared function.
      body:
        item.status === "merged"
          ? appendBody(priorBodyByName.get(item.input.name.toLocaleLowerCase()) ?? "", item.input.body)
          : item.input.body,
      prompt: item.input.prompt,
      topics: item.input.topics,
      // `undefined` rather than `false`, so upsertConcept's null-guard
      // leaves existing tracking alone. See RememberConcept.tracked.
      tracked: item.input.tracked === true ? true : undefined,
      ingestId: batchId,
    });
    nameToId.set(item.input.name.toLocaleLowerCase(), result.id);
    for (const alias of item.input.aliases ?? []) {
      nameToId.set(alias.toLocaleLowerCase(), result.id);
    }
    if (result.created) createdIds.push(result.id);
    else mergedIds.push(result.id);

    // Keep the outcome's reported status honest: a concept the resolver
    // expected to create may have been created by a concurrent call a moment
    // earlier, in which case this was a merge.
    const outcome = outcomes.find(
      (o) => o.name.toLocaleLowerCase() === (input.concepts[i]?.name ?? "").toLocaleLowerCase(),
    );
    if (outcome && outcome.status !== "ambiguous" && outcome.status !== "rejected") {
      outcome.id = result.id;
      outcome.status = result.created ? "created" : "merged";
    }
  }

  // ── Links ──────────────────────────────────────────────────────────────────
  const skipped: Array<RememberLink & { reason: string }> = [];
  const createdEdges: string[] = [];

  const resolve = async (ref: string): Promise<string | null> => {
    const key = ref.trim().toLocaleLowerCase();
    if (nameToId.has(key)) return nameToId.get(key)!;
    const exact = await findExact(ref);
    if (exact) return exact.id;
    const byId = await read(
      "MATCH (c:Concept {id: $id}) WHERE c.deletedAt IS NULL RETURN c.id AS id",
      { id: ref },
    );
    return byId.records[0] ? String(byId.records[0].get("id")) : null;
  };

  for (const link of input.links ?? []) {
    const fromId = await resolve(link.from);
    const toId = await resolve(link.to);
    if (!fromId || !toId) {
      // Skipped and reported, never auto-stubbed. Creating empty placeholder
      // concepts for unknown link targets quietly fills the graph with
      // orphans that then pollute search and the review queue.
      skipped.push({
        ...link,
        reason: !fromId ? `Unknown concept "${link.from}".` : `Unknown concept "${link.to}".`,
      });
      continue;
    }
    if (fromId === toId) {
      skipped.push({ ...link, reason: "A concept cannot be linked to itself." });
      continue;
    }
    await linkConcepts(fromId, toId, link.type, {
      note: link.note,
      weight: link.weight,
      ingestId: batchId,
    });
    createdEdges.push(JSON.stringify({ from: fromId, to: toId, type: link.type }));
  }

  // ── Source ─────────────────────────────────────────────────────────────────
  if (input.source?.kind) {
    const sourceId = randomUUID();
    await write(
      `
      CREATE (s:Source {id: $id, kind: $kind, ref: $ref, title: $title,
                        capturedAt: datetime(), ingestId: $batchId})
      WITH s
      UNWIND $conceptIds AS cid
      MATCH (c:Concept {id: cid})
      MERGE (c)-[r:CITES]->(s)
        ON CREATE SET r.createdAt = datetime(), r.traversals = 0, r.ingestId = $batchId
      `,
      {
        id: sourceId,
        kind: input.source.kind,
        ref: input.source.ref ?? null,
        title: input.source.title ?? null,
        batchId,
        conceptIds: [...new Set([...createdIds, ...mergedIds])],
      },
    );
  }

  // ── Inbox ──────────────────────────────────────────────────────────────────
  // Cleared in the same call as the write, which is why this is a parameter
  // and not a separate tool: a failed ingest must not lose the raw note.
  let inboxCleared = 0;
  if (input.consumesInbox?.length) {
    const result = await write(
      `
      UNWIND $ids AS id
      MATCH (b:Inbox {id: id})
      SET b.processed = true, b.processedAt = datetime(), b.ingestId = $batchId
      RETURN count(b) AS n
      `,
      { ids: input.consumesInbox, batchId },
    );
    inboxCleared = result.records[0]?.get("n")?.toNumber?.() ?? 0;
  }

  // ── Link suggestions, returned unprompted ──────────────────────────────────
  // Each conversation is blind to the others, so without this the graph
  // becomes a pile of disconnected per-conversation islands — folders with
  // extra steps. Returning candidates in the same result means the default
  // path does the right thing without relying on a second tool call.
  const suggestions: RememberResult["suggestions"] = [];
  for (const id of [...createdIds, ...mergedIds].slice(0, 10)) {
    const row = await read(
      "MATCH (c:Concept {id: $id}) RETURN c.name AS name, c.embedding AS vec",
      { id },
    );
    const vec = row.records[0]?.get("vec") as number[] | null;
    if (!vec) continue;
    const linked = await read(
      "MATCH (c:Concept {id: $id})-[]-(o:Concept) RETURN collect(DISTINCT o.id) AS ids",
      { id },
    );
    const exclude = [id, ...((linked.records[0]?.get("ids") as string[]) ?? [])];
    const candidates = await findSimilar(vec, { excludeIds: exclude, limit: 3, minScore: 0.6 });
    if (candidates.length) {
      suggestions.push({
        id,
        name: String(row.records[0].get("name")),
        candidates: candidates.map((c) => ({
          id: c.id,
          name: c.name,
          score: Math.round(c.score * 1000) / 1000,
        })),
      });
    }
  }

  const result: RememberResult = {
    batchId,
    reviewUrl: `${baseUrl()}/ingest/${batchId}`,
    replayed: false,
    counts: tally(outcomes),
    concepts: outcomes,
    links: { written: createdEdges.length, skipped },
    suggestions,
    inboxCleared,
  };

  await write(
    `
    MATCH (i:Ingest {id: $id})
    SET i.createdIds   = $createdIds,
        i.mergedIds    = $mergedIds,
        i.createdEdges = $createdEdges,
        i.resultJson   = $json,
        i.summary      = $summary
    `,
    {
      id: batchId,
      createdIds,
      mergedIds,
      createdEdges,
      json: JSON.stringify(result),
      summary:
        `${createdIds.length} created, ${mergedIds.length} merged, ` +
        `${createdEdges.length} link(s)`,
    },
  );

  return result;
}

/**
 * Combine an existing note with new material.
 *
 * Returns the prior body unchanged when there is nothing new, and when the new
 * text is already present — which stops a replayed or repeated ingest from
 * stacking the same paragraph up over and over.
 */
export function appendBody(prior: string, incoming?: string): string | undefined {
  const next = (incoming ?? "").trim();
  if (!next) return prior || undefined;
  const before = (prior ?? "").trim();
  if (!before) return next;
  if (before.includes(next)) return before;
  return `${before}\n\n${next}`;
}

function tally(outcomes: ConceptOutcome[]) {
  return {
    created: outcomes.filter((o) => o.status === "created").length,
    merged: outcomes.filter((o) => o.status === "merged").length,
    ambiguous: outcomes.filter((o) => o.status === "ambiguous").length,
    rejected: outcomes.filter((o) => o.status === "rejected").length,
  };
}

export interface UndoResult {
  ok: boolean;
  batchId: string;
  alreadyUndone: boolean;
  conceptsRemoved: number;
  bodiesRestored: number;
  edgesRemoved: number;
  note: string;
}

/**
 * Reverse one batch.
 *
 * Concepts the batch created are **tombstoned, not destroyed** — consistent
 * with the rule that nothing reachable from MCP is irreversible, and it means
 * an undo issued by mistake is itself undoable. Merged concepts get their
 * previous body and aliases back from the record written before the merge.
 * Edges the batch created are removed outright; they are cheap to recreate and
 * the batch record still lists them.
 *
 * Idempotent: a second undo reports that and changes nothing.
 */
export async function undoIngest(batchId: string): Promise<UndoResult> {
  const found = await read(
    `
    MATCH (i:Ingest {id: $id})
    RETURN i.undone AS undone, i.createdIds AS createdIds, i.mergedIds AS mergedIds,
           i.mergedPrior AS mergedPrior, i.createdEdges AS createdEdges
    `,
    { id: batchId },
  );
  const rec = found.records[0];
  if (!rec) {
    return {
      ok: false,
      batchId,
      alreadyUndone: false,
      conceptsRemoved: 0,
      bodiesRestored: 0,
      edgesRemoved: 0,
      note: `No ingest batch with id ${batchId}.`,
    };
  }
  if (rec.get("undone")) {
    return {
      ok: true,
      batchId,
      alreadyUndone: true,
      conceptsRemoved: 0,
      bodiesRestored: 0,
      edgesRemoved: 0,
      note: "That batch was already undone; nothing changed.",
    };
  }

  const createdIds = (rec.get("createdIds") as string[]) ?? [];
  const mergedPrior = ((rec.get("mergedPrior") as string[]) ?? []).flatMap((s) => {
    try {
      return [JSON.parse(s) as { id: string; body: string; aliases: string[] }];
    } catch {
      return [];
    }
  });
  const createdEdges = ((rec.get("createdEdges") as string[]) ?? []).flatMap((s) => {
    try {
      return [JSON.parse(s) as { from: string; to: string; type: string }];
    } catch {
      return [];
    }
  });

  let conceptsRemoved = 0;
  if (createdIds.length) {
    const res = await write(
      `
      UNWIND $ids AS id
      MATCH (c:Concept {id: id}) WHERE c.deletedAt IS NULL
      SET c.deletedAt = datetime()
      RETURN count(c) AS n
      `,
      { ids: createdIds },
    );
    conceptsRemoved = res.records[0]?.get("n")?.toNumber?.() ?? 0;
  }

  let bodiesRestored = 0;
  if (mergedPrior.length) {
    const res = await write(
      `
      UNWIND $rows AS row
      MATCH (c:Concept {id: row.id})
      SET c.body = row.body, c.aliases = row.aliases, c.updatedAt = datetime()
      RETURN count(c) AS n
      `,
      { rows: mergedPrior },
    );
    bodiesRestored = res.records[0]?.get("n")?.toNumber?.() ?? 0;
  }

  let edgesRemoved = 0;
  for (const edge of createdEdges) {
    if (!isRelType(edge.type)) continue;
    const res = await write(
      `
      MATCH (a:Concept {id: $from})-[r:${edge.type}]->(b:Concept {id: $to})
      WHERE r.ingestId = $batchId
      DELETE r
      RETURN count(r) AS n
      `,
      { from: edge.from, to: edge.to, batchId },
    );
    edgesRemoved += res.records[0]?.get("n")?.toNumber?.() ?? 0;
  }

  await write("MATCH (i:Ingest {id: $id}) SET i.undone = true, i.undoneAt = datetime()", {
    id: batchId,
  });

  return {
    ok: true,
    batchId,
    alreadyUndone: false,
    conceptsRemoved,
    bodiesRestored,
    edgesRemoved,
    note:
      `Reversed. ${conceptsRemoved} concept(s) tombstoned (recoverable), ` +
      `${bodiesRestored} body/bodies restored, ${edgesRemoved} link(s) removed.`,
  };
}
