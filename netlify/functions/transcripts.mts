import type { Context, Config } from "@netlify/functions";
import { reprocessRecording, listMeetingSummaries, listDecisions } from "../lib/transcripts-core.ts";

/**
 * SAM PHASE 1.4 — TRANSCRIPT HTTP ENDPOINTS
 *
 *   POST /api/transcripts/reprocess  → body: {recordingId} re-run extraction
 *   GET  /api/transcripts/summaries  → list meeting summaries
 *   GET  /api/decisions              → list decision log
 *   GET  /api/decisions?project=X    → filter by project
 */

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/api/transcripts/reprocess" && req.method === "POST") {
    try {
      const { recordingId } = await req.json();
      if (!recordingId) return json({ error: "Missing recordingId" }, 400);
      const result = await reprocessRecording(recordingId);
      return json(result, result.ok ? 200 : 400);
    } catch (e: any) {
      return json({ error: e.message, stack: e.stack }, 500);
    }
  }

  if (path === "/api/transcripts/summaries" && req.method === "GET") {
    try {
      const limit = parseInt(url.searchParams.get("limit") || "20", 10);
      const summaries = await listMeetingSummaries(limit);
      return json({ summaries, count: summaries.length }, 200, true, 60);
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  if (path === "/api/decisions" && req.method === "GET") {
    try {
      const limit = parseInt(url.searchParams.get("limit") || "50", 10);
      const project = url.searchParams.get("project") || undefined;
      const decisions = await listDecisions(limit, project);
      return json({ decisions, count: decisions.length }, 200, true, 60);
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
  path: [
    "/api/transcripts/reprocess",
    "/api/transcripts/summaries",
    "/api/decisions",
  ],
};
