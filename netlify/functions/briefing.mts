import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { buildAndSendBriefing } from "../lib/briefing-core.ts";

/**
 * SAM PHASE 1.1 — BRIEFING HTTP ENDPOINTS
 *
 * Three endpoints so the dashboard (and David) can interact with the
 * briefing engine without waiting for the 6 AM cron:
 *
 *   POST /api/briefing/now         → fire a briefing right now
 *   GET  /api/briefing/history     → last 30 briefing dates
 *   GET  /api/briefing/get?date=   → read one archived briefing
 */

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/api/briefing/now" && req.method === "POST") {
    try {
      const result = await buildAndSendBriefing();
      return json(result, 200);
    } catch (e: any) {
      console.error("Manual briefing failed:", e);
      return json({ error: e.message, stack: e.stack }, 500);
    }
  }

  if (path === "/api/briefing/history" && req.method === "GET") {
    try {
      const store = getStore({ name: "sam-briefings", consistency: "strong" });
      const { blobs } = await store.list();
      const dates = blobs
        .map((b: any) => b.key)
        .sort()
        .reverse()
        .slice(0, 30);
      return json({ dates, count: blobs.length }, 200);
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  if (path === "/api/briefing/get" && req.method === "GET") {
    const date = url.searchParams.get("date");
    if (!date) return json({ error: "Missing date param (YYYY-MM-DD)" }, 400);
    try {
      const store = getStore({ name: "sam-briefings", consistency: "strong" });
      const data = await store.get(date, { type: "json" });
      if (!data) return json({ error: "Not found" }, 404);
      return json(data, 200);
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  return json({ error: "Not found", path }, 404);
};

function json(body: any, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const config: Config = {
  path: ["/api/briefing/now", "/api/briefing/history", "/api/briefing/get"],
};
