import type { Context, Config } from "@netlify/functions";
import { runAllReactors } from "../lib/reactor.ts";
// Importing reactors.ts triggers their registerReactor() side effects
import "../lib/reactors.ts";

/**
 * Phase 5: scheduled reactor runner.
 *
 * Runs every minute. Polls the events table for events not yet processed
 * by each registered reactor, dispatches them, records the outcome.
 *
 * Idempotency: each (event, reactor) pair gets exactly one row in
 * reactor_processed regardless of how many times this function fires.
 *
 * Cost bound: sinceMinutesBack=60 + limit=50 caps any single run at 50
 * events per reactor, so a misconfigured reactor can't blow up costs.
 *
 * Manual trigger: also exposed at /api/admin/reactor-run for testing.
 */

export default async (_req: Request, _ctx: Context) => {
  const startedAt = Date.now();
  try {
    const summary = await runAllReactors({ sinceMinutesBack: 60, limit: 50 });
    const elapsedMs = Date.now() - startedAt;
    console.log(`[reactor-run] ${JSON.stringify({ ...summary, elapsed_ms: elapsedMs })}`);
    return new Response(JSON.stringify({ ok: true, ...summary, elapsed_ms: elapsedMs }, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("[reactor-run] failed:", e?.message || e);
    return new Response(JSON.stringify({ ok: false, error: e?.message || String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const config: Config = {
  // Manual trigger for testing AND scheduled run via cron
  path: "/api/admin/reactor-run",
  schedule: "* * * * *", // every minute
};
