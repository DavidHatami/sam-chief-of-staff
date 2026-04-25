import type { Context, Config } from "@netlify/functions";
import { runConflictHunt, listOpenConflicts, updateConflictStatus } from "../lib/conflicts-core.ts";

/**
 * SAM PHASE 1.3 — CONFLICT HTTP ENDPOINTS
 *
 *   POST /api/conflicts/run       → force a scan now
 *   GET  /api/conflicts/open      → list unresolved conflicts
 *   POST /api/conflicts/resolve   → body: {id}
 *   POST /api/conflicts/dismiss   → body: {id}
 */

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/api/conflicts/run" && req.method === "POST") {
    try {
      const result = await runConflictHunt();
      return json(result, 200);
    } catch (e: any) {
      return json({ error: e.message, stack: e.stack }, 500);
    }
  }

  if (path === "/api/conflicts/open" && req.method === "GET") {
    try {
      const conflicts = await listOpenConflicts();
      return json({ conflicts, count: conflicts.length }, 200, true);
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  if (path === "/api/conflicts/resolve" && req.method === "POST") {
    try {
      const { id } = await req.json();
      if (!id) return json({ error: "Missing id" }, 400);
      const ok = await updateConflictStatus(id, "resolved");
      return json({ ok }, ok ? 200 : 404);
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  if (path === "/api/conflicts/dismiss" && req.method === "POST") {
    try {
      const { id } = await req.json();
      if (!id) return json({ error: "Missing id" }, 400);
      const ok = await updateConflictStatus(id, "dismissed");
      return json({ ok }, ok ? 200 : 404);
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  return json({ error: "Not found", path }, 404);
};

function json(body: any, status: number, cacheable = false) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cacheable && status === 200) {
    headers["Cache-Control"] = "private, max-age=30, stale-while-revalidate=120";
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export const config: Config = {
  path: [
    "/api/conflicts/run",
    "/api/conflicts/open",
    "/api/conflicts/resolve",
    "/api/conflicts/dismiss",
  ],
};
