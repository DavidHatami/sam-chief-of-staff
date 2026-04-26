import type { Context, Config } from "@netlify/functions";

// redeploy marker: phase1-env-fix
/**
 * Phase 1 debug endpoint — explicitly verifies Postgres reachability.
 * Returns every step's pass/fail with raw error text, no swallowing.
 *
 *   GET /api/admin/pg-probe
 */

export default async (req: Request, _ctx: Context) => {
  const result: any = {
    ok: false,
    steps: [],
    timestamp: new Date().toISOString(),
  };

  function step(name: string, ok: boolean, detail?: any) {
    result.steps.push({ name, ok, detail });
  }

  // STEP 1: env vars present?
  // @ts-ignore Netlify global
  const url = typeof Netlify !== "undefined" ? Netlify.env.get("SUPABASE_URL") : process.env.SUPABASE_URL;
  // @ts-ignore Netlify global
  const key = typeof Netlify !== "undefined" ? Netlify.env.get("SUPABASE_PUBLISHABLE_KEY") : process.env.SUPABASE_PUBLISHABLE_KEY;
  step("env_vars", !!(url && key), { url_set: !!url, key_set: !!key, url_prefix: url ? url.substring(0, 30) : null });
  if (!url || !key) {
    return new Response(JSON.stringify(result, null, 2), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }

  // STEP 2: can we import @supabase/supabase-js at all?
  let createClient: any;
  try {
    const mod = await import("@supabase/supabase-js");
    createClient = mod.createClient;
    step("import_supabase_lib", typeof createClient === "function", { type: typeof createClient });
  } catch (e: any) {
    step("import_supabase_lib", false, { error: e?.message || String(e), stack: (e?.stack || "").split("\n").slice(0, 5) });
    return new Response(JSON.stringify(result, null, 2), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }

  // STEP 3: can we instantiate a client?
  let client: any;
  try {
    client = createClient(url, key, { auth: { persistSession: false } });
    step("create_client", !!client, { type: typeof client });
  } catch (e: any) {
    step("create_client", false, { error: e?.message || String(e) });
    return new Response(JSON.stringify(result, null, 2), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }

  // STEP 4: can we make a read query?
  try {
    const { data, error } = await client.from("sam_meta").select("key, value").eq("key", "flags").maybeSingle();
    step("read_sam_meta", !error, { error: error?.message, data });
  } catch (e: any) {
    step("read_sam_meta", false, { error: e?.message || String(e) });
  }

  // STEP 5: can we import the sam-db helper?
  try {
    const dbMod = await import("../lib/sam-db.ts");
    step("import_sam_db", typeof dbMod.getDb === "function", { exports: Object.keys(dbMod) });
    
    // STEP 6: does getDb() return a non-null client?
    const db = dbMod.getDb();
    step("sam_db_get_db", !!db, { is_null: !db });
    
    // STEP 7: try the rpc emit_event call
    if (db) {
      try {
        const eid = await dbMod.emitEvent({
          type: "admin.pg_probe",
          source: "pg_probe",
          payload: { ok: true, ts: result.timestamp },
        });
        step("emit_event_rpc", !!eid, { event_id: eid });
      } catch (e: any) {
        step("emit_event_rpc", false, { error: e?.message || String(e) });
      }
    }
  } catch (e: any) {
    step("import_sam_db", false, { error: e?.message || String(e) });
  }

  result.ok = result.steps.every((s: any) => s.ok);
  return new Response(JSON.stringify(result, null, 2), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/admin/pg-probe",
};
