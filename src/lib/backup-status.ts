import fs from "node:fs";
import path from "node:path";

/**
 * Backup freshness, reported by /api/health.
 *
 * A backup that stopped running three weeks ago is worse than no backup,
 * because you believe you have one. The absence of a new file is easy to
 * overlook; a health endpoint that says `stale: true` is not. This is the same
 * class of silent failure the runbook already documents for this box — the
 * Tailscale node key that quietly expires, the VAPID keys whose loss stops
 * notifications while everything still looks healthy.
 */

/** Read-only bind mount of the host's ./backups. */
const BACKUP_DIR = process.env.BACKUP_DIR ?? "/backups";

/** Nightly schedule, so two missed nights is the point of concern. */
const STALE_AFTER_HOURS = 48;

const DATED_JSON = /^brain-\d{4}-\d{2}-\d{2}\.json$/;

export interface BackupStatus {
  lastExport: string | null;
  ageHours: number | null;
  stale: boolean;
  count: number;
  lastRun?: { ok: boolean; at: string; error?: string };
  note?: string;
}

export function backupStatus(): BackupStatus {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      return {
        lastExport: null,
        ageHours: null,
        stale: true,
        count: 0,
        note: `${BACKUP_DIR} is not mounted`,
      };
    }

    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => DATED_JSON.test(f))
      .sort()
      .reverse();

    // Read the run record too, so a run that FAILED is reported rather than
    // looking identical to one that never happened.
    let lastRun: BackupStatus["lastRun"];
    const runFile = path.join(BACKUP_DIR, "last-run-export-json.json");
    if (fs.existsSync(runFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(runFile, "utf8"));
        lastRun = { ok: Boolean(parsed.ok), at: String(parsed.at), error: parsed.error };
      } catch {
        // A corrupt record is not worth failing the health check over.
      }
    }

    if (files.length === 0) {
      return {
        lastExport: null,
        ageHours: null,
        stale: true,
        count: 0,
        lastRun,
        note: "no export has run yet",
      };
    }

    // Trust mtime rather than the filename date: a file named for today that
    // was actually written a week ago is exactly the case worth catching.
    const newest = path.join(BACKUP_DIR, files[0]);
    const mtime = fs.statSync(newest).mtime;
    const ageHours = (Date.now() - mtime.getTime()) / 3_600_000;

    return {
      lastExport: files[0],
      ageHours: Math.round(ageHours * 10) / 10,
      stale: ageHours > STALE_AFTER_HOURS,
      count: files.length,
      lastRun,
    };
  } catch (err) {
    return {
      lastExport: null,
      ageHours: null,
      stale: true,
      count: 0,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}
