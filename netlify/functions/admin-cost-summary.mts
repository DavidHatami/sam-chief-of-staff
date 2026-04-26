import type { Context, Config } from "@netlify/functions";
import { getDb } from "../lib/sam-db.ts";

/**
 * Phase 8 / 9: cost summary endpoint.
 *
 *   GET /api/admin/cost-summary
 *   GET /api/admin/cost-summary?days=7
 *   GET /api/admin/cost-summary?days=30&group=feature
 *   GET /api/admin/cost-summary?days=30&group=model
 *
 * Returns aggregated AI usage and cost. Powered by the model_costs table
 * which is populated by netlify/lib/llm-cost.ts. Cost is 0 until pricing
 * constants are filled in there; tokens are tracked from day one.
 */

export default async (req: Request, _ctx: Context) => {
  const url = new URL(req.url);
  const days = Math.max(1, Math.min(90, parseInt(url.searchParams.get("days") || "7", 10)));
  const group = url.searchParams.get("group") || "day"; // day | feature | model

  const db = getDb();
  if (!db) {
    return new Response(JSON.stringify({ error: "DB unavailable" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const sinceISO = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  try {
    // Pull rows; group in JS so we don't need a SQL view per dimension
    const { data, error } = await db
      .from("model_costs")
      .select("occurred_at, model, feature, input_tokens, output_tokens, cached_input_tokens, cost_cents")
      .gte("occurred_at", sinceISO);
    if (error) throw new Error(error.message);

    const rows = data || [];
    const totals = {
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      cost_cents: 0,
      call_count: rows.length,
    };
    const groups: Record<string, any> = {};

    for (const r of rows) {
      const key =
        group === "day" ? (r.occurred_at as string).substring(0, 10)
        : group === "model" ? (r.model || "unknown")
        : (r.feature || "unknown"); // group=feature

      if (!groups[key]) {
        groups[key] = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cost_cents: 0, call_count: 0 };
      }
      const g = groups[key];
      g.input_tokens += r.input_tokens || 0;
      g.output_tokens += r.output_tokens || 0;
      g.cached_input_tokens += r.cached_input_tokens || 0;
      g.cost_cents += parseFloat(r.cost_cents) || 0;
      g.call_count += 1;
      totals.input_tokens += r.input_tokens || 0;
      totals.output_tokens += r.output_tokens || 0;
      totals.cached_input_tokens += r.cached_input_tokens || 0;
      totals.cost_cents += parseFloat(r.cost_cents) || 0;
    }

    // Sort group entries: by date descending if day-grouped, by cost descending otherwise
    const sortedGroups = Object.entries(groups).sort(([ka, va]: [string, any], [kb, vb]: [string, any]) => {
      if (group === "day") return kb.localeCompare(ka);
      return vb.cost_cents - va.cost_cents || vb.call_count - va.call_count;
    });

    return new Response(JSON.stringify({
      ok: true,
      window: { days, since: sinceISO },
      group_by: group,
      totals: {
        ...totals,
        cost_dollars: (totals.cost_cents / 100).toFixed(4),
      },
      groups: Object.fromEntries(sortedGroups.map(([k, v]: [string, any]) => [
        k, { ...v, cost_dollars: (v.cost_cents / 100).toFixed(4) }
      ])),
      note: "Cost dollars will be 0 until pricing constants in netlify/lib/llm-cost.ts are filled in. Token counts are accurate.",
    }, null, 2), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const config: Config = {
  path: "/api/admin/cost-summary",
};
