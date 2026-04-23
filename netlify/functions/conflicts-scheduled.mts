import type { Context, Config } from "@netlify/functions";
import { runConflictHunt } from "../lib/conflicts-core.ts";

/**
 * SAM PHASE 1.3 — SCHEDULED CALENDAR CONFLICT HUNTER
 *
 * Runs every 30 minutes. Scans next 14 days for overlaps, tight gaps,
 * and focus-block violations. Sends a digest email when new conflicts
 * appear. Dedupes on conflict hash so already-alerted issues go silent.
 */

export default async (req: Request, context: Context) => {
  try {
    const result = await runConflictHunt();
    console.log(
      `[CONFLICTS] events=${result.totalEvents}`,
      `overlaps=${result.detected.overlaps}`,
      `tightGaps=${result.detected.tightGaps}`,
      `focusViolations=${result.detected.focusViolations}`,
      `newRecorded=${result.newlyRecorded} notified=${result.notified}`,
      `(${result.durationMs}ms)`
    );
  } catch (e: any) {
    console.error("[CONFLICTS] scheduled run failed:", e.message);
  }
};

export const config: Config = {
  schedule: "*/30 * * * *",
};
