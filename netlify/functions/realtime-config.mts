import type { Context, Config } from "@netlify/functions";
import { isFlagOn } from "../lib/sam-db.js";

/**
 * REALTIME CONFIG — exposes Supabase URL + publishable key to the browser.
 *
 * The publishable key is the renamed anon key. It's safe to ship to the
 * client because Postgres RLS (or its absence + the SECURITY DEFINER stored
 * procs we use for mutations) does the actual access control. Reads from
 * the browser Realtime channel only see what RLS lets them see.
 *
 * Frontend hits this once on load. If realtime_enabled is false, the
 * frontend stays in polling mode and never opens a websocket.
 */
export default async (req: Request, _context: Context) => {
  const url = Netlify.env.get("SUPABASE_URL") || "";
  const key = Netlify.env.get("SUPABASE_PUBLISHABLE_KEY") || "";
  let enabled = false;
  try {
    enabled = await isFlagOn("realtime_enabled");
  } catch {
    enabled = false;
  }
  return new Response(
    JSON.stringify({
      supabase_url: url,
      supabase_publishable_key: key,
      realtime_enabled: enabled && !!url && !!key,
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    }
  );
};

export const config: Config = {
  path: ["/api/realtime-config"],
};
