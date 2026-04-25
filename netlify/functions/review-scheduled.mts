import type { Context, Config } from "@netlify/functions";
import { buildAndSendReview } from "../lib/review-core.ts";
import { withHeartbeat } from "../lib/cron-heartbeat.ts";

/**
 * SAM PHASE 2.3 — SCHEDULED WEEKLY REVIEW
 *
 * Fires every Sunday at 22:00 UTC (6 PM EDT / 5 PM EST).
 * Heartbeat-wrapped so cron-watchdog detects silent failures.
 */

export default async (req: Request, context: Context) => {
  await withHeartbeat("review-scheduled", async () => {
    const result = await buildAndSendReview();
    console.log(`[REVIEW] sent ${result.key} (${result.durationMs}ms)`);
    return result;
  });
};

export const config: Config = {
  schedule: "0 22 * * 0",
};
