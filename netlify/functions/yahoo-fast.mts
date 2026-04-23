import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

/**
 * SAM — YAHOO FAST-PATH HTTP ENDPOINT
 *
 * Reads inbox/sent snapshot from the sam-yahoo-cache blob populated by
 * yahoo-warmer.mts (scheduled every 2 minutes). No IMAP, no waiting.
 * Typical response: 50–150ms vs. 1500ms+ on the legacy /api/yahoo/mail path.
 *
 * Client contract matches the existing /api/yahoo/mail response so the
 * frontend can swap base URL without other changes.
 *
 * If snapshot is missing or older than 10 min, responds 503 with a
 * fallback hint so the client knows to fall through to the slow path.
 */

const STALE_AFTER_MS = 10 * 60 * 1000;

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const path = url.pathname.replace("/api/yahoo-fast", "");

  if (path === "/mail" && req.method === "GET") {
    const folder = (url.searchParams.get("folder") || "inbox").toLowerCase();
    const top = parseInt(url.searchParams.get("top") || "25", 10);

    try {
      const store = getStore({ name: "sam-yahoo-cache", consistency: "strong" });
      const snap = await store.get("snapshot", { type: "json" });
      if (!snap) {
        return new Response(
          JSON.stringify({ error: "No snapshot yet; warmer hasn't run. Use /api/yahoo/mail", fallback: true }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        );
      }
      const age = Date.now() - new Date(snap.refreshedAt).getTime();
      if (age > STALE_AFTER_MS) {
        return new Response(
          JSON.stringify({ error: `Snapshot stale by ${Math.round(age / 1000)}s`, fallback: true, refreshedAt: snap.refreshedAt }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        );
      }
      const source = folder === "sent" || folder === "sentitems" ? snap.sent : snap.inbox;
      const value = Array.isArray(source) ? source.slice(0, top) : [];
      return new Response(
        JSON.stringify({
          value,
          refreshedAt: snap.refreshedAt,
          ageSeconds: Math.round(age / 1000),
          source: "cache",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Cache": "blob-snapshot",
            "Cache-Control": "private, max-age=30, stale-while-revalidate=60",
          },
        }
      );
    } catch (e: any) {
      return new Response(
        JSON.stringify({ error: e.message, fallback: true }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  // Status endpoint — is the cache live, how old, how many messages
  if (path === "/status" && req.method === "GET") {
    try {
      const store = getStore({ name: "sam-yahoo-cache", consistency: "strong" });
      const snap = await store.get("snapshot", { type: "json" });
      if (!snap) {
        return new Response(JSON.stringify({ warm: false }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      const age = Date.now() - new Date(snap.refreshedAt).getTime();
      return new Response(
        JSON.stringify({
          warm: age <= STALE_AFTER_MS,
          refreshedAt: snap.refreshedAt,
          ageSeconds: Math.round(age / 1000),
          inboxCount: snap.inbox?.length || 0,
          sentCount: snap.sent?.length || 0,
          lastBuildMs: snap.durationMs || null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }
  }

  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404, headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: ["/api/yahoo-fast/mail", "/api/yahoo-fast/status"],
};
