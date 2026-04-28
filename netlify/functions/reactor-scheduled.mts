import type { Config } from "@netlify/functions";
import { runAllReactors } from "../lib/reactor.ts";
// Side-effect import: registering reactors happens at module load time
import "../lib/reactors.ts";

/**
 * Phase 5: scheduled reactor runner.
 *
 * Cron-only. Runs every 5 minutes. Polls events table since the last 60
 * minutes, dispatches new events to each registered reactor, records
 * outcomes in reactor_runs.
 *
 * Manual counterpart at /api/admin/reactor-run for testing.
 *
 * Bounded: sinceMinutesBack=60 + limit=50 caps any single run at 50
 * events per reactor. A misconfigured reactor cannot blow up costs.
 *
 * Gated by reactor_enabled flag. When false, runAllReactors() returns
 * an empty summary without hitting Postgres.
 */

export default async () => {
  const startedAt = Date.now();
  try {
    const summary = await runAllReactors({ sinceMinutesBack: 60, limit: 50 });
    const elapsedMs = Date.now() - startedAt;
    if (summary.reactions_ran > 0 || summary.reactions_failed > 0) {
      console.log(`[reactor-cron] ${JSON.stringify({ ...summary, elapsed_ms: elapsedMs })}`);
    }
    return new Response("ok", { status: 200 });
  } catch (e: any) {
    console.error("[reactor-cron] failed:", e?.message || e);
    return new Response(`error: ${e?.message || e}`, { status: 500 });
  }
};

export const config: Config = {
  schedule: "*/5 * * * *", // every 5 minutes — credit-budget conscious
};
