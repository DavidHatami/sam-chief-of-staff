import type { Context, Config } from "@netlify/functions";
import { buildAndSendBriefing } from "../lib/briefing-core.ts";

/**
 * SAM PHASE 1.1 — SCHEDULED MORNING BRIEFING
 *
 * Fires every day at 10:00 UTC (6 AM EDT / 5 AM EST).
 * Delegates all logic to lib/briefing-core.ts so the manual HTTP
 * trigger (briefing.mts) shares the same implementation.
 */

export default async (req: Request, context: Context) => {
  try {
    const result = await buildAndSendBriefing();
    console.log("Scheduled briefing sent:", result.key, `(${result.durationMs}ms)`);
  } catch (e: any) {
    console.error("Scheduled briefing failed:", e.message, e.stack);
  }
};

export const config: Config = {
  schedule: "0 10 * * *",
};
