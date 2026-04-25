import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { buildAndSendReview } from "../lib/review-core.ts";

/**
 * SAM PHASE 2.3 — WEEKLY REVIEW HTTP
 *
 *   POST /api/review/now            — fire a review immediately
 *   GET  /api/review/history        — list recent reviews
 *   GET  /api/review/get?date=      — read one archived review
 */

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/api/review/now" && req.method === "POST") {
    try {
      const result = await buildAndSendReview();
      return json(result, 200);
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  if (path === "/api/review/history" && req.method === "GET") {
    try {
      const store = getStore({ name: "sam-reviews", consistency: "strong" });
      const { blobs } = await store.list();
      const dates = blobs.map((b: any) => b.key).sort().reverse().slice(0, 52);
      return json({ dates, count: blobs.length }, 200, true, 60);
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  if (path === "/api/review/get" && req.method === "GET") {
    const date = url.searchParams.get("date");
    if (!date) return json({ error: "Missing date param" }, 400);
    try {
      const store = getStore({ name: "sam-reviews", consistency: "strong" });
      const data = await store.get(date, { type: "json" });
      if (!data) return json({ error: "Not found" }, 404);
      return json(data, 200, true, 600);  // archived reviews never change
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  return json({ error: "Not found", path }, 404);
};

function json(body: any, status: number, cacheable = false, maxAge = 30) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cacheable && status === 200) {
    headers["Cache-Control"] = `private, max-age=${maxAge}, stale-while-revalidate=${maxAge * 4}`;
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export const config: Config = {
  path: ["/api/review/now", "/api/review/history", "/api/review/get"],
};
