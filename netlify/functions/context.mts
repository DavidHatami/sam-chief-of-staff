import type { Context, Config } from "@netlify/functions";
import { buildContext } from "../lib/context-core.ts";

/**
 * SAM PHASE 2.2 — CLIENT CONTEXT PAGES HTTP
 *
 *   GET /api/context?entity=hccfl.edu
 *   GET /api/context?entity=Hillsborough+Community+College
 *   GET /api/context?entity=sarah.dolezal@example.com
 *
 * Returns every piece of context SAM has about the entity: emails in
 * both directions, calendar events, tasks, zoom transcripts, captured
 * decisions, relationship timeline, and the last reply David sent them
 * (used as voice seed for future drafts).
 */

export default async (req: Request, context: Context) => {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const url = new URL(req.url);
  const entity = url.searchParams.get("entity");
  if (!entity) return json({ error: "Missing 'entity' query param" }, 400);
  if (entity.length < 2) return json({ error: "Entity must be at least 2 chars" }, 400);

  try {
    const result = await buildContext(entity);
    return json(result, 200);
  } catch (e: any) {
    console.error("[CONTEXT] failed:", e);
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
  path: "/api/context",
};
