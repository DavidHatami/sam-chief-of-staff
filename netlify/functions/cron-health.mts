import type { Context, Config } from "@netlify/functions";
import { buildHealthReport } from "../lib/cron-heartbeat.ts";

/**
 * SAM CRON HEALTH — HTTP endpoint
 *   GET /api/cron/health → status of every scheduled job
 */

export default async (req: Request, context: Context) => {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }
  try {
    const report = await buildHealthReport();
    return new Response(JSON.stringify(report), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, max-age=30, stale-while-revalidate=120",
      },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const config: Config = {
  path: "/api/cron/health",
};
