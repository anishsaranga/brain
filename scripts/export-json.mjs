/**
 * Tier 1 backup: the whole graph as portable JSON. Runs online, no downtime.
 *
 *   npm run export:json            # nightly target
 *   npm run export:json -- --with-embeddings
 *
 * Writes backups/brain-<date>.json, prunes old ones, and mirrors off-box.
 * Exits 1 on failure so a scheduled task records a real result.
 */
import path from "node:path";
import {
  BACKUP_DIR, ensureDir, writeAtomic, pruneRotation, mirror, recordRun,
  todayStamp, explainFailure,
} from "./backup-common.mjs";

const withEmbeddings = process.argv.includes("--with-embeddings");
const started = Date.now();

const dir = ensureDir(BACKUP_DIR);
const target = path.join(dir, `brain-${todayStamp()}.json`);

try {
  const { exportGraph } = await import("@/lib/export");
  const { getDriver } = await import("@/lib/neo4j");

  const data = await exportGraph({ withEmbeddings });
  const json = JSON.stringify(data, null, 2);
  writeAtomic(target, json);

  const { deleted } = pruneRotation(dir);
  const mirrored = mirror(target);

  const summary = {
    ok: true,
    file: target,
    bytes: json.length,
    counts: data.counts,
    embeddingsIncluded: withEmbeddings,
    pruned: deleted.length,
    mirroredTo: mirrored,
    ms: Date.now() - started,
  };
  recordRun(dir, "export-json", summary);

  const kb = (json.length / 1024).toFixed(1);
  console.log(`[export] ${target} — ${kb} KB, ${JSON.stringify(data.counts)}`);
  if (mirrored) console.log(`[export] mirrored to ${mirrored}`);
  if (deleted.length) console.log(`[export] pruned ${deleted.length} old backup(s)`);

  await getDriver().close();
} catch (err) {
  const reason = explainFailure(err);
  recordRun(dir, "export-json", { ok: false, error: reason, ms: Date.now() - started });
  console.error(`[export] FAILED: ${reason}`);
  process.exit(1);
}
