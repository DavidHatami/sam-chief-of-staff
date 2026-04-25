import type { Context, Config } from "@netlify/functions";
import { runConflictHunt } from "../lib/conflicts-core.ts";
import { withHeartbeat } from "../lib/cron-heartbeat.ts";

/**
 * SAM PHASE 1.3 — SCHEDULED CALENDAR CONFLICT HUNTER
 *
 * Runs every 30 minutes. Scans next 14 days for overlaps, tight gaps,
 * and focus-block violations. Heartbeat-wrapped.
 */

export default async (req: Request, context: Context) => {
  await withHeartbeat("conflicts-scheduled", async () => {
    const result = await runConflictHunt();
    console.log(
      `[CONFLICTS] events=${result.totalEvents}`,
      `overlaps=${result.detected.overlaps}`,
      `tightGaps=${result.detected.tightGaps}`,
      `focusViolations=${result.detected.focusViolations}`,
      `newRecorded=${result.newlyRecorded} notified=${result.notified}`,
      `(${result.durationMs}ms)`
    );
    return result;
  });
};

export const config: Config = {
  schedule: "*/30 * * * *",
};
