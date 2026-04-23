import type { Context, Config } from "@netlify/functions";
import { runTriage } from "../lib/triage-core.ts";

/**
 * SAM PHASE 1.2 — SCHEDULED EMAIL TRIAGE
 *
 * Every 20 minutes: check M365 + Gmail for new mail since last cursor,
 * classify with Claude, draft replies for respond_today / respond_this_week,
 * store in sam-triage blob store.
 */

export default async (req: Request, context: Context) => {
  try {
    const result = await runTriage(false);
    console.log(
      `[TRIAGE] processed ${result.processed} in ${result.durationMs}ms`,
      JSON.stringify(result.byBucket)
    );
  } catch (e: any) {
    console.error("[TRIAGE] scheduled run failed:", e.message);
  }
};

export const config: Config = {
  schedule: "*/20 * * * *",
};
