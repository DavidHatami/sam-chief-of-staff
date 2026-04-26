import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

/**
 * ADMIN: WIPE OAUTH BLOB STORE
 *
 * Deletes every clients/, codes/, tokens/ entry from the "sam-oauth" store.
 * Useful after a failed connector setup left ghost clients or stale codes
 * lying around. Auth: Authorization: Bearer <SAM_MCP_SECRET>.
 *
 * GET  → counts entries (read-only inventory)
 * POST → wipes everything, returns counts of what was deleted
 */
export default async (req: Request, _ctx: Context): Promise<Response> => {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const presented = (m?.[1] || "").trim();
  const expected = (Netlify.env.get("SAM_MCP_SECRET") || "").trim();
  if (!expected || presented !== expected) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const store = getStore({ name: "sam-oauth", consistency: "strong" });
  const { blobs } = await store.list();
  const counts = { clients: 0, codes: 0, tokens: 0, other: 0 };
  for (const b of blobs) {
    if (b.key.startsWith("clients/")) counts.clients++;
    else if (b.key.startsWith("codes/")) counts.codes++;
    else if (b.key.startsWith("tokens/")) counts.tokens++;
    else counts.other++;
  }

  if (req.method === "GET") {
    return new Response(JSON.stringify({ mode: "inventory", counts, total: blobs.length }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // POST → delete everything
  let deleted = 0;
  for (const b of blobs) {
    try {
      await store.delete(b.key);
      deleted++;
    } catch {
      // best-effort; keep going
    }
  }
  return new Response(JSON.stringify({ mode: "wipe", before: counts, deleted, remaining: blobs.length - deleted }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/admin/oauth-reset",
};
