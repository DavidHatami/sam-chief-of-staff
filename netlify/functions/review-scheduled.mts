import type { Context, Config } from "@netlify/functions";
import { buildAndSendReview } from "../lib/review-core.ts";

/**
 * SAM PHASE 2.3 — SCHEDULED WEEKLY REVIEW
 *
 * Fires every Sunday at 22:00 UTC (6 PM EDT / 5 PM EST).
 * Composes a look-back + look-ahead for the week and emails it.
 */

export default async (req: Request, context: Context) => {
  try {
    const result = await buildAndSendReview();
    console.log(`[REVIEW] sent ${result.key} (${result.durationMs}ms)`);
  } catch (e: any) {
    console.error("[REVIEW] scheduled failed:", e.message);
  }
};

export const config: Config = {
  schedule: "0 22 * * 0",
};
