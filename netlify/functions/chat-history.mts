import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

/**
 * SAM CHAT HISTORY — read/clear persistent SAM dialogue
 *
 *   GET  /api/chat-history           → last 30 turns (default)
 *   GET  /api/chat-history?n=100     → last N turns (capped at 200)
 *   GET  /api/chat-history?since=ISO → turns AFTER a specific timestamp
 *   DELETE /api/chat-history         → clear all history (with confirmation)
 *
 * The dashboard chat widget calls GET on init to pre-populate the dialogue
 * panel so SAM doesn't look amnesiac after a refresh. The actual model
 * context injection happens inside ai.mts — this endpoint is for the UI.
 */

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const store = getStore({ name: "sam-chat-history", consistency: "strong" });

  if (req.method === "GET") {
    try {
      const stored = (await store.get("turns", { type: "json" })) as Array<{
        role: string;
        content: string;
        at?: string;
        model?: string;
      }> | null;
      const turns = Array.isArray(stored) ? stored : [];

      // Filter by `since` timestamp if provided
      let filtered = turns;
      const since = url.searchParams.get("since");
      if (since) {
        filtered = turns.filter((t) => t.at && t.at > since);
      }

      // Take last N (default 30, max 200)
      const requested = parseInt(url.searchParams.get("n") || "30", 10);
      const n = Math.min(Math.max(1, requested || 30), 200);
      const tail = filtered.slice(-n);

      return new Response(
        JSON.stringify({
          turns: tail,
          totalStored: turns.length,
          oldestRetainedAt: turns[0]?.at || null,
          newestRetainedAt: turns[turns.length - 1]?.at || null,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "private, max-age=10, stale-while-revalidate=60",
          },
        }
      );
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e?.message || String(e) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  if (req.method === "DELETE") {
    // Require explicit confirm parameter so a stray DELETE can't wipe history
    const confirm = url.searchParams.get("confirm");
    if (confirm !== "yes") {
      return new Response(
        JSON.stringify({ error: "Add ?confirm=yes to actually delete all chat history" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    try {
      // Read first so we can report how many we discarded
      const stored = (await store.get("turns", { type: "json" })) as any[] | null;
      const discarded = Array.isArray(stored) ? stored.length : 0;
      await store.delete("turns");
      return new Response(
        JSON.stringify({ ok: true, discarded }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e?.message || String(e) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // PUT — atomic full-corpus restore. Used by E2E tests to snapshot+restore
  // chat history around a test run instead of wiping production data.
  // Body shape: { turns: [...] } where each turn is { role, content, at?, model? }.
  if (req.method === "PUT") {
    try {
      const body = await req.json();
      const turns = body?.turns;
      if (!Array.isArray(turns)) {
        return new Response(
          JSON.stringify({ error: "Body must be { turns: [...] } where turns is an array" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      // Validate each turn has the required shape
      const valid = turns.every((t: any) => t && typeof t === "object" && typeof t.role === "string" && typeof t.content === "string");
      if (!valid) {
        return new Response(
          JSON.stringify({ error: "Every turn must be an object with string role and content fields" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      await store.setJSON("turns", turns);
      return new Response(
        JSON.stringify({ ok: true, restored: turns.length }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e?.message || String(e) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/chat-history",
};
