/**
 * Shared filesystem bits for the backup scripts: atomic writes, rotation, and
 * the run record that makes a silent failure visible.
 */
import fs from "node:fs";
import path from "node:path";

export const BACKUP_DIR = process.env.BACKUP_DIR ?? "./backups";

/**
 * Off-box copy. Text exports also land here so they sync away from this disk.
 * Set BACKUP_MIRROR_DIR="" to turn it off.
 */
export const MIRROR_DIR =
  process.env.BACKUP_MIRROR_DIR ?? "C:/Users/anish/OneDrive/brain-backups";

/** Keep this many dated files. Anything older is pruned — see pruneRotation. */
export const KEEP_DAILY = 14;
export const KEEP_MONTHLY = 12;

/** `brain-2026-10-16.json` — the date is the rotation key. */
const DATED = /^brain-(\d{4})-(\d{2})-(\d{2})\.(json|md\.d)$/;

export function todayStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write via a temp file and rename.
 *
 * An interrupted write must not leave a truncated file sitting in the backup
 * directory looking like a valid backup. Rename is atomic within a filesystem,
 * so a reader sees either the old file or the complete new one.
 */
export function writeAtomic(filePath, contents) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
  return filePath;
}

/**
 * Prune dated backups, keeping the most recent `KEEP_DAILY` plus the newest
 * file from each of the last `KEEP_MONTHLY` months.
 *
 * Only ever deletes files matching this script's own naming pattern. A backup
 * pruner that can delete something it did not write is its own disaster, so
 * anything else in the directory — a manual copy, a note, somebody's export —
 * is left strictly alone.
 */
export function pruneRotation(dir, { keepDaily = KEEP_DAILY, keepMonthly = KEEP_MONTHLY } = {}) {
  if (!fs.existsSync(dir)) return { kept: [], deleted: [] };

  const dated = fs
    .readdirSync(dir)
    .map((name) => ({ name, match: DATED.exec(name) }))
    .filter((f) => f.match)
    .map((f) => ({ name: f.name, date: `${f.match[1]}-${f.match[2]}-${f.match[3]}`, month: `${f.match[1]}-${f.match[2]}` }))
    .sort((a, b) => b.date.localeCompare(a.date));

  const keep = new Set(dated.slice(0, keepDaily).map((f) => f.name));

  const seenMonths = new Set();
  for (const f of dated) {
    if (seenMonths.has(f.month)) continue;
    seenMonths.add(f.month);
    if (seenMonths.size <= keepMonthly) keep.add(f.name);
  }

  const deleted = [];
  for (const f of dated) {
    if (keep.has(f.name)) continue;
    const target = path.join(dir, f.name);
    fs.rmSync(target, { recursive: true, force: true });
    deleted.push(f.name);
  }

  return { kept: [...keep], deleted };
}

/**
 * Record the outcome of a run.
 *
 * A backup that stopped working three weeks ago is worse than no backup,
 * because you believe you have one. The absence of a new file is easy to
 * overlook; a record that says "failed, here is why" is not. /api/health reads
 * the newest export's age and reports staleness from it.
 */
export function recordRun(dir, name, payload) {
  const file = path.join(dir, `last-run-${name}.json`);
  const record = { name, at: new Date().toISOString(), ...payload };
  try {
    writeAtomic(file, JSON.stringify(record, null, 2));
  } catch (err) {
    console.error(`[backup] could not write run record: ${err.message}`);
  }
  return record;
}

/** Copy a file (or directory) into the off-box mirror, if one is configured. */
export function mirror(sourcePath) {
  if (!MIRROR_DIR) return null;
  try {
    ensureDir(MIRROR_DIR);
    const dest = path.join(MIRROR_DIR, path.basename(sourcePath));
    fs.cpSync(sourcePath, dest, { recursive: true });
    return dest;
  } catch (err) {
    // A mirror failure must not fail the backup: the local copy is already
    // written and is the one that matters most.
    console.error(`[backup] mirror to ${MIRROR_DIR} failed: ${err.message}`);
    return null;
  }
}

/**
 * Turn a connection failure into one clear line.
 *
 * Docker Desktop on this box is a GUI app that only starts on an interactive
 * login, so a scheduled 4am run WILL sometimes find no engine and no Neo4j.
 * That is an expected condition to log plainly, not a stack trace to decode
 * six weeks later.
 */
export function explainFailure(err) {
  const message = String(err?.message ?? err);
  if (/ECONNREFUSED|ServiceUnavailable|Could not perform discovery/i.test(message)) {
    return (
      "Neo4j was unreachable. If this was a scheduled run, Docker Desktop was " +
      "probably not running — it only starts on an interactive login, so an " +
      "unattended reboot leaves it down until someone signs in. See " +
      "SERVICES-RUNBOOK.md."
    );
  }
  return message;
}
