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
