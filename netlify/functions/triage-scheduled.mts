import type { Context, Config } from "@netlify/functions";
import { runTriage } from "../lib/triage-core.ts";
import { withHeartbeat } from "../lib/cron-heartbeat.ts";

/**
 * SAM PHASE 1.2 — SCHEDULED EMAIL TRIAGE
 *
 * Every 20 minutes: check M365 + Gmail for new mail, classify with Claude,
 * draft replies, store in sam-triage blob. Heartbeat-wrapped.
 */

export default async (req: Request, context: Context) => {
  await withHeartbeat("triage-scheduled", async () => {
    const result = await runTriage(false);
    console.log(
      `[TRIAGE] processed ${result.processed} in ${result.durationMs}ms`,
      JSON.stringify(result.byBucket)
    );
    return result;
  });
};

export const config: Config = {
  schedule: "*/20 * * * *",
};
