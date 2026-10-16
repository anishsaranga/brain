/**
 * Tier 3 backup: one markdown file per concept.
 *
 *   npm run export:md
 *
 * Needs no Neo4j, no importer and no JSON parser to read, and the folder works
 * as an Obsidian vault as-is. This is the difference between a system you can
 * leave and a trap.
 */
import path from "node:path";
import fs from "node:fs";
import {
  BACKUP_DIR, ensureDir, writeAtomic, pruneRotation, mirror, recordRun,
  todayStamp, explainFailure,
} from "./backup-common.mjs";

const started = Date.now();
const dir = ensureDir(BACKUP_DIR);
// `.md.d` so the rotation pattern treats a directory of notes as one dated
// artefact, same as a dated .json file.
const target = path.join(dir, `brain-${todayStamp()}.md.d`);

try {
  const { exportGraph, toMarkdownFiles } = await import("@/lib/export");
  const { getDriver } = await import("@/lib/neo4j");

  const data = await exportGraph();
  const files = toMarkdownFiles(data);

  fs.rmSync(target, { recursive: true, force: true });
  ensureDir(target);
  for (const file of files) {
    writeAtomic(path.join(target, file.filename), file.content);
  }

  const { deleted } = pruneRotation(dir);
  const mirrored = mirror(target);

  recordRun(dir, "export-markdown", {
    ok: true, dir: target, files: files.length,
    pruned: deleted.length, mirroredTo: mirrored, ms: Date.now() - started,
  });

  console.log(`[export-md] ${target} — ${files.length} concept file(s)`);
  if (mirrored) console.log(`[export-md] mirrored to ${mirrored}`);

  await getDriver().close();
} catch (err) {
  const reason = explainFailure(err);
  recordRun(dir, "export-markdown", { ok: false, error: reason, ms: Date.now() - started });
  console.error(`[export-md] FAILED: ${reason}`);
  process.exit(1);
}
