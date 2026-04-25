import type { Context, Config } from "@netlify/functions";
import { buildUnifiedInbox } from "../lib/unified-inbox-core.ts";

/**
 * SAM PHASE 2.1 — UNIFIED INBOX HTTP
 *
 *   GET /api/unified-inbox
 *   GET /api/unified-inbox?filter=actionable      (respond_today + respond_this_week only)
 *   GET /api/unified-inbox?filter=respond_today
 *   GET /api/unified-inbox?per_account=50         (default 40, max 100)
 *
 * Returns one merged stream of M365 + Gmail + Yahoo, sorted by urgency
 * derived from the Phase 1.2 triage classifications. Every message carries
 * an `account` field so the UI can render a source pill.
 */

export default async (req: Request, context: Context) => {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const url = new URL(req.url);
  const filter = url.searchParams.get("filter") || undefined;
  const perAccountRaw = url.searchParams.get("per_account");
  const perAccount = perAccountRaw ? parseInt(perAccountRaw, 10) : undefined;

  try {
    const result = await buildUnifiedInbox({ perAccount, filter });
    return json(result, 200, true);
  } catch (e: any) {
    console.error("[UNIFIED-INBOX] failed:", e);
    return json({ error: e.message }, 500);
  }
};

function json(body: any, status: number, cacheable = false) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cacheable && status === 200) {
    headers["Cache-Control"] = "private, max-age=30, stale-while-revalidate=120";
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export const config: Config = {
  path: "/api/unified-inbox",
};
