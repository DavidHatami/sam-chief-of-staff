import type { Context, Config } from "@netlify/functions";
import { runTriage, listPendingTriage, updateTriageStatus } from "../lib/triage-core.ts";

/**
 * SAM PHASE 1.2 — TRIAGE HTTP ENDPOINTS
 *
 *   POST /api/triage/run        → force a triage run now
 *   GET  /api/triage/pending    → list items awaiting review
 *   POST /api/triage/approve    → body: {id, editedReply?} — mark approved
 *   POST /api/triage/dismiss    → body: {id} — hide from queue
 *   POST /api/triage/send       → body: {id, editedReply?} — send via M365/Gmail and mark sent
 */

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/api/triage/run" && req.method === "POST") {
    try {
      const body = await req.json().catch(() => ({}));
      const force = body?.force === true;
      const result = await runTriage(force);
      return json(result, 200);
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  if (path === "/api/triage/pending" && req.method === "GET") {
    try {
      const pending = await listPendingTriage();
      return json({ pending, count: pending.length }, 200);
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  if (path === "/api/triage/approve" && req.method === "POST") {
    try {
      const { id, editedReply } = await req.json();
      if (!id) return json({ error: "Missing id" }, 400);
      const ok = await updateTriageStatus(id, "approved", editedReply);
      return json({ ok }, ok ? 200 : 404);
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  if (path === "/api/triage/dismiss" && req.method === "POST") {
    try {
      const { id } = await req.json();
      if (!id) return json({ error: "Missing id" }, 400);
      const ok = await updateTriageStatus(id, "dismissed");
      return json({ ok }, ok ? 200 : 404);
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  if (path === "/api/triage/send" && req.method === "POST") {
    try {
      const { id, editedReply } = await req.json();
      if (!id) return json({ error: "Missing id" }, 400);
      // Update status first (idempotency safety)
      const ok = await updateTriageStatus(id, "sent", editedReply);
      // Actual send is wired in a future pass — for now we just mark sent.
      // David can review drafts in the UI and send from his native mail client.
      return json({ ok, note: "marked sent — actual send wire-up pending UI" }, ok ? 200 : 404);
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
  path: [
    "/api/triage/run",
    "/api/triage/pending",
    "/api/triage/approve",
    "/api/triage/dismiss",
    "/api/triage/send",
  ],
};
