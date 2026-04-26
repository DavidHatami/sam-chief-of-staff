import type { Context, Config } from "@netlify/functions";
import { runAllReactors } from "../lib/reactor.ts";
// Importing reactors.ts triggers their registerReactor() side effects
import "../lib/reactors.ts";

/**
 * Phase 5: manual reactor trigger endpoint.
 *
 * Runs the reactor pipeline once on demand. Useful for testing, debugging,
 * and forced sweeps after a code change. Returns the run summary.
 *
 * The scheduled counterpart is reactor-scheduled.mts (cron every minute).
 * Splitting them is a Netlify Functions constraint: a function with both
 * `path` and `schedule` only fires on schedule, not via HTTP.
 *
 *   GET /api/admin/reactor-run
 */

export default async (_req: Request, _ctx: Context) => {
  const startedAt = Date.now();
  try {
    const summary = await runAllReactors({ sinceMinutesBack: 60, limit: 50 });
    const elapsedMs = Date.now() - startedAt;
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
  path: "/api/admin/reactor-run",
};
