import type { Context, Config } from "@netlify/functions";
import { runSearch } from "../lib/search-core.ts";

/**
 * SAM PHASE 2.4 — CROSS-REFERENCE SEARCH HTTP
 *
 *   GET /api/search?q=Sarah+Dolezal
 *   GET /api/search?q=gulf+coast&limit=100
 *
 * One query, fans out to every source SAM stores. Returns ranked hits
 * by relevance score with type badges so the UI can render a unified
 * result list.
 */

export default async (req: Request, context: Context) => {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const url = new URL(req.url);
  const q = url.searchParams.get("q");
  if (!q || q.trim().length < 2) {
    return json({ error: "Query must be at least 2 characters" }, 400);
  }
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;

  try {
    const result = await runSearch(q.trim(), { limit });
    return json(result, 200);
  } catch (e: any) {
    console.error("[SEARCH] failed:", e);
    return json({ error: e.message }, 500);
  }
};

function json(body: any, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const config: Config = {
  path: "/api/search",
};
