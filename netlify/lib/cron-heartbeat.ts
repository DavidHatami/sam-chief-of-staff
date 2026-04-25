/**
 * SAM CRON HEARTBEAT — shared helper
 *
 * Every scheduled function writes a heartbeat to `sam-cron-heartbeat` blob on
 * each successful run. The cron-watchdog function reads the blob, compares
 * each timestamp against expected intervals, and alerts if anything is stale.
 *
 * Why a single blob keyed by job name (not per-job blobs)? One blob read tells
 * the watchdog everything it needs. Cuts watchdog time from 7 reads to 1.
 */

import { getStore } from "@netlify/blobs";

export interface HeartbeatRecord {
  lastRunAt: string;          // ISO timestamp of last completion
  lastSuccess: boolean;        // true if completed without error
  lastDurationMs: number;      // how long it took
  lastError?: string;          // truncated error message if !success
  consecutiveFailures: number; // zero on success, increments on error
}

export type CronJobName =
  | "backup-nightly"
  | "briefing-daily"
  | "conflicts-scheduled"
  | "review-scheduled"
  | "triage-scheduled"
  | "yahoo-warmer"
  | "zoom-check-background"
  | "memory-extract-scheduled"
  | "anticipations-scheduled";

/**
 * Write a heartbeat entry for a scheduled job. Called at the end of each
 * cron run (success OR failure). Best-effort — never throws, never blocks.
 */
export async function writeHeartbeat(
  job: CronJobName,
  result: {
    success: boolean;
    durationMs: number;
    error?: string;
  }
): Promise<void> {
  try {
    const store = getStore({ name: "sam-cron-heartbeat", consistency: "strong" });

    // Read existing record to track consecutiveFailures
    let consecutiveFailures = 0;
    if (!result.success) {
      try {
        const existing = (await store.get(job, { type: "json" })) as HeartbeatRecord | null;
        consecutiveFailures = (existing?.consecutiveFailures ?? 0) + 1;
      } catch {
        consecutiveFailures = 1;
      }
    }

    const record: HeartbeatRecord = {
      lastRunAt: new Date().toISOString(),
      lastSuccess: result.success,
      lastDurationMs: Math.round(result.durationMs),
      ...(result.error ? { lastError: result.error.substring(0, 300) } : {}),
      consecutiveFailures,
    };

    await store.setJSON(job, record);
  } catch {
    // Heartbeat write must NEVER break the actual cron job.
    // Watchdog will catch it via stale timestamp anyway.
  }
}

/**
 * Convenience wrapper: run a cron task and emit heartbeat regardless of outcome.
 * Usage:
 *   export default async () => withHeartbeat("triage-scheduled", async () => {
 *     await runTriage(false);
 *   });
 */
export async function withHeartbeat<T>(
  job: CronJobName,
  fn: () => Promise<T>
): Promise<T | null> {
  const start = Date.now();
  try {
    const result = await fn();
    await writeHeartbeat(job, {
      success: true,
      durationMs: Date.now() - start,
    });
    return result;
  } catch (e: any) {
    await writeHeartbeat(job, {
      success: false,
      durationMs: Date.now() - start,
      error: e?.message || String(e),
    });
    console.error(`[${job}] failed:`, e?.message, e?.stack);
    return null;
  }
}

/**
 * Read all heartbeats. Used by the watchdog.
 */
export async function readAllHeartbeats(): Promise<Record<string, HeartbeatRecord>> {
  const store = getStore({ name: "sam-cron-heartbeat", consistency: "strong" });
  const { blobs } = await store.list();
  const out: Record<string, HeartbeatRecord> = {};
  for (const b of blobs) {
    try {
      const rec = (await store.get(b.key, { type: "json" })) as HeartbeatRecord | null;
      if (rec) out[b.key] = rec;
    } catch {
      // skip unreadable
    }
  }
  return out;
}

/**
 * Expected heartbeat intervals per job. The watchdog uses these to determine
 * "stale" — anything older than (interval × 2) is suspicious, older than
 * (interval × 3) is alarming.
 */
export const CRON_EXPECTED_INTERVAL_MS: Record<CronJobName, number> = {
  "backup-nightly":         24 * 60 * 60 * 1000,  // 24h (cron: 0 7 * * *)
  "briefing-daily":         24 * 60 * 60 * 1000,  // 24h (cron: 0 10 * * *)
  "conflicts-scheduled":    30 * 60 * 1000,       // 30m
  "review-scheduled":        7 * 24 * 60 * 60 * 1000, // 7d (cron: 0 22 * * 0)
  "triage-scheduled":       20 * 60 * 1000,       // 20m
  "yahoo-warmer":            2 * 60 * 1000,       //  2m
  "zoom-check-background":  15 * 60 * 1000,       // 15m
  "memory-extract-scheduled": 6 * 60 * 60 * 1000, // 6h (cron: 0 */6 * * *)
  "anticipations-scheduled": 24 * 60 * 60 * 1000, // 24h (cron: 0 11 * * *)
};

// ─────────────────────────────────────────────────────────────────────────
// HEALTH REPORT — used by both /api/cron/health (HTTP) and the scheduled
// watchdog (which emails on stale conditions). Keeping it in this lib means
// neither caller needs to duplicate the threshold math.
// ─────────────────────────────────────────────────────────────────────────

export interface JobStatus {
  job: string;
  status: "ok" | "warning" | "alarm" | "unknown";
  lastRunAt: string | null;
  lastSuccess: boolean | null;
  lastDurationMs: number | null;
  lastError: string | null;
  ageMs: number | null;
  expectedIntervalMs: number;
  consecutiveFailures: number;
  reason: string;
}

export interface HealthReport {
  jobs: JobStatus[];
  summary: {
    ok: number;
    warning: number;
    alarm: number;
    total: number;
    overall: "ok" | "warning" | "alarm";
  };
}

export async function buildHealthReport(): Promise<HealthReport> {
  const heartbeats = await readAllHeartbeats();
  const jobs: JobStatus[] = [];
  const now = Date.now();

  for (const [name, expectedMs] of Object.entries(CRON_EXPECTED_INTERVAL_MS) as [CronJobName, number][]) {
    const hb = heartbeats[name];
    if (!hb) {
      jobs.push({
        job: name,
        status: "alarm",
        lastRunAt: null, lastSuccess: null, lastDurationMs: null, lastError: null,
        ageMs: null,
        expectedIntervalMs: expectedMs,
        consecutiveFailures: 0,
        reason: "No heartbeat ever recorded",
      });
      continue;
    }
    const ageMs = now - new Date(hb.lastRunAt).getTime();
    const warnThreshold = expectedMs * 2;
    const alarmThreshold = expectedMs * 3;

    let status: "ok" | "warning" | "alarm" = "ok";
    let reason = "Healthy";

    if (ageMs > alarmThreshold) {
      status = "alarm";
      reason = `Stale: ${formatAge(ageMs)} since last run (expected every ${formatAge(expectedMs)})`;
    } else if (ageMs > warnThreshold) {
      status = "warning";
      reason = `Slow: ${formatAge(ageMs)} since last run (expected every ${formatAge(expectedMs)})`;
    } else if (hb.consecutiveFailures >= 3) {
      status = "alarm";
      reason = `${hb.consecutiveFailures} consecutive failures: ${hb.lastError || "no detail"}`;
    } else if (hb.consecutiveFailures >= 1) {
      status = "warning";
      reason = `${hb.consecutiveFailures} recent failure${hb.consecutiveFailures === 1 ? "" : "s"}: ${hb.lastError || "no detail"}`;
    } else if (!hb.lastSuccess) {
      status = "warning";
      reason = `Last run failed: ${hb.lastError || "no detail"}`;
    }

    jobs.push({
      job: name,
      status,
      lastRunAt: hb.lastRunAt,
      lastSuccess: hb.lastSuccess,
      lastDurationMs: hb.lastDurationMs,
      lastError: hb.lastError || null,
      ageMs,
      expectedIntervalMs: expectedMs,
      consecutiveFailures: hb.consecutiveFailures,
      reason,
    });
  }

  const summary = {
    ok: jobs.filter((j) => j.status === "ok").length,
    warning: jobs.filter((j) => j.status === "warning").length,
    alarm: jobs.filter((j) => j.status === "alarm").length,
    total: jobs.length,
    overall: jobs.some((j) => j.status === "alarm")
      ? ("alarm" as const)
      : jobs.some((j) => j.status === "warning")
      ? ("warning" as const)
      : ("ok" as const),
  };

  return { jobs, summary };
}

export function formatAge(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  if (ms < 86400000) return `${(ms / 3600000).toFixed(1)}h`;
  return `${(ms / 86400000).toFixed(1)}d`;
}
