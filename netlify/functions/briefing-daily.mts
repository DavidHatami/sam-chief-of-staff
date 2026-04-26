import type { Context, Config } from "@netlify/functions";
import { buildAndSendBriefing } from "../lib/briefing-core.ts";
import { withHeartbeat } from "../lib/cron-heartbeat.ts";

/**
 * SAM PHASE 1.1 — SCHEDULED MORNING BRIEFING
 *
 * Fires every day at 10:00 UTC (6 AM EDT / 5 AM EST).
 * Heartbeat-wrapped so cron-watchdog detects silent failures.
 */

export default async (req: Request, context: Context) => {
  await withHeartbeat("briefing-daily", async () => {
    const result = await buildAndSendBriefing();
    console.log("Scheduled briefing sent:", result.key, `(${result.durationMs}ms)`);
    return result;
  });
};

export const config: Config = {
  schedule: "0 10 * * *",
};

// Schedule re-registration touch: 2026-04-26 — Netlify cron scheduler had stopped firing
// these jobs (4 alarms in cron-watchdog with 'No heartbeat ever recorded'). Manual invokes
// confirmed the function code is healthy. Forcing redeploy to re-register the schedule.
