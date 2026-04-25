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
      return json({ pending, count: pending.length }, 200, true);
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

      // Load the triage item to get recipient + subject + draft
      const { getStore } = await import("@netlify/blobs");
      const store = getStore({ name: "sam-triage", consistency: "strong" });
      const item: any = await store.get(id, { type: "json" });
      if (!item) return json({ error: "Triage item not found" }, 404);

      const replyBody = (editedReply !== undefined ? editedReply : item.draftReply || "").trim();
      if (!replyBody || replyBody === "None") {
        return json({ error: "No reply body — refusing to send empty message" }, 400);
      }

      const toAddr = item.fromEmail || "";
      if (!toAddr) return json({ error: "No recipient address on triage item" }, 400);

      const subject = (item.subject || "").startsWith("Re:") ? item.subject : `Re: ${item.subject || ""}`;

      // Route by account. Per memory: "Yahoo send routes through M365."
      const sendRoute = item.account === "gmail" ? "/api/gmail/mail/send" : "/api/m365/mail/send";
      const origin = new URL(req.url).origin;

      const sendResp = await fetch(`${origin}${sendRoute}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: [toAddr],
          subject,
          content: replyBody,
          contentType: "Text",
        }),
      });

      if (!sendResp.ok) {
        const errBody = await sendResp.text();
        return json({
          error: `Send failed via ${sendRoute}: HTTP ${sendResp.status} — ${errBody.substring(0, 200)}`,
          route: sendRoute,
        }, 502);
      }

      // Update triage status only after a confirmed send
      const ok = await updateTriageStatus(id, "sent", replyBody);
      return json({
        ok,
        sent: true,
        route: sendRoute,
        to: toAddr,
        subject,
      }, ok ? 200 : 404);
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  return json({ error: "Not found", path }, 404);
};

function json(body: any, status: number, cacheable = false) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cacheable && status === 200) {
    // Browser caches for 30s, then serves stale for 2 minutes while revalidating in background.
    // Mutations (approve/dismiss/send/run) bypass this since they're POST.
    // Page-tab switches within the same minute become instant.
    headers["Cache-Control"] = "private, max-age=30, stale-while-revalidate=120";
  }
  return new Response(JSON.stringify(body), { status, headers });
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
