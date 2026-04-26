/**
 * SAM REACTOR FRAMEWORK — Phase 5
 *
 * The reactor is what turns the event log from a passive record into an
 * active nervous system. Each reactor declares which event types it cares
 * about and runs a side effect when those events fire.
 *
 * Architecture:
 *   1. A scheduled function calls runAllReactors() every minute.
 *   2. runAllReactors() polls the events table for new events since the
 *      last cursor, then dispatches each event to every registered reactor
 *      whose `interestedIn` filter matches.
 *   3. Each (event, reactor) pair is recorded in reactor_processed BEFORE
 *      the reaction runs. This is the idempotency guarantee — if the same
 *      event arrives twice, the reactor runs once.
 *   4. reactor_runs records started/completed/failed, retry count, cost.
 *
 * Why polling instead of live LISTEN/NOTIFY: Netlify Functions don't keep
 * persistent connections. A polling cron gives us the same reactor pattern
 * with infrastructure that already exists. Phase 7 moves this to Inngest
 * which handles the orchestration properly.
 */

import { getDb, isFlagOn, recordModelCost } from "./sam-db.ts";

export interface SamEvent {
  id: string;
  type: string;
  version: number;
  entity_type: string | null;
  entity_id: string | null;
  occurred_at: string;
  payload: Record<string, any>;
  source: string | null;
  correlation_id: string | null;
  created_at: string;
}

export interface ReactorContext {
  event: SamEvent;
  // Helpers for reactors to record their own activity
  recordCost: (input: { model: string; feature: string; inputTokens: number; outputTokens: number; costCents: number }) => Promise<void>;
}

export interface Reactor {
  /** Stable identifier — used as primary key in reactor_processed. Don't rename. */
  name: string;
  /** Optional comma-list of event types or a predicate. Empty = all events. */
  interestedIn: (eventType: string) => boolean;
  /** The actual side effect. Throw on failure to mark the run as failed. */
  run(ctx: ReactorContext): Promise<{ result?: any; costCents?: number } | void>;
}

const REGISTRY: Reactor[] = [];

export function registerReactor(r: Reactor) {
  if (REGISTRY.some((x) => x.name === r.name)) {
    console.warn(`[reactor] reactor "${r.name}" already registered — skipping`);
    return;
  }
  REGISTRY.push(r);
}

/**
 * Returns events since `sinceTime` that haven't been processed by `reactorName` yet.
 * The double filter (time + processed) keeps the query bounded. We process
 * events in occurred_at order so reactor side effects respect causality.
 */
async function fetchPendingEvents(reactorName: string, sinceTime: string, limit: number = 50): Promise<SamEvent[]> {
  const db = getDb();
  if (!db) return [];
  const { data, error } = await db
    .from("events")
    .select("id, type, version, entity_type, entity_id, occurred_at, payload, source, correlation_id, created_at")
    .gte("occurred_at", sinceTime)
    .order("occurred_at", { ascending: true })
    .limit(limit);
  if (error) {
    console.error(`[reactor] fetchPendingEvents: ${error.message}`);
    return [];
  }
  if (!data || data.length === 0) return [];
  // Filter out events already processed by this reactor (idempotency check)
  const ids = data.map((e: any) => e.id);
  const { data: processedRows, error: pErr } = await db
    .from("reactor_processed")
    .select("event_id")
    .eq("reactor_name", reactorName)
    .in("event_id", ids);
  if (pErr) {
    console.error(`[reactor] processed lookup: ${pErr.message}`);
    return [];
  }
  const processedSet = new Set((processedRows || []).map((r: any) => r.event_id));
  return data.filter((e: any) => !processedSet.has(e.id));
}

/**
 * Process a single (event, reactor) pair. Records the run, executes the
 * reactor, marks processed (or failed). Idempotent: if reactor_processed
 * already has the row, returns immediately without running.
 */
async function processOne(reactor: Reactor, event: SamEvent): Promise<"ran" | "skipped" | "failed"> {
  if (!reactor.interestedIn(event.type)) return "skipped";

  const db = getDb();
  if (!db) return "failed";

  // Pre-flight: claim the event for this reactor. If insert fails on
  // primary key conflict, another worker already processed it.
  const { error: claimErr } = await db
    .from("reactor_processed")
    .insert({ event_id: event.id, reactor_name: reactor.name });
  if (claimErr) {
    if (claimErr.code === "23505") return "skipped"; // duplicate key — already processed
    console.error(`[reactor] claim failed for ${reactor.name}/${event.id}:`, claimErr.message);
    return "failed";
  }

  // Open a run row to record this attempt
  const { data: runRow } = await db
    .from("reactor_runs")
    .insert({
      event_id: event.id,
      reactor_name: reactor.name,
      status: "running",
    })
    .select("id")
    .single();
  const runId = runRow?.id;

  let totalCostCents = 0;
  const ctx: ReactorContext = {
    event,
    recordCost: async (input) => {
      totalCostCents += input.costCents;
      await recordModelCost({
        model: input.model,
        feature: `reactor:${reactor.name}`,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        costCents: input.costCents,
        metadata: { event_id: event.id, event_type: event.type },
      });
    },
  };

  try {
    const result = await reactor.run(ctx);
    const summary = result?.result ?? null;
    if (runId) {
      await db
        .from("reactor_runs")
        .update({
          status: "succeeded",
          completed_at: new Date().toISOString(),
          cost_cents: totalCostCents,
          result: summary,
        })
        .eq("id", runId);
    }
    return "ran";
  } catch (e: any) {
    const errMsg = e?.message || String(e);
    console.error(`[reactor] ${reactor.name} failed on ${event.id}:`, errMsg);
    if (runId) {
      await db
        .from("reactor_runs")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          error: errMsg.substring(0, 500),
        })
        .eq("id", runId);
    }
    // Roll back the processed row so a retry can pick this up. If the
    // failure was transient (network blip) the next run gets it. If
    // permanent (bug), we'll see repeated failures in reactor_runs.
    await db.from("reactor_processed").delete().eq("event_id", event.id).eq("reactor_name", reactor.name);
    return "failed";
  }
}

/**
 * Top-level entry. Walks the registry, fetches pending events for each,
 * processes them. Returns counts so the caller can log/monitor.
 */
export async function runAllReactors(opts: { sinceMinutesBack?: number; limit?: number } = {}): Promise<{
  reactors_run: number;
  events_examined: number;
  reactions_ran: number;
  reactions_skipped: number;
  reactions_failed: number;
  per_reactor: Record<string, { examined: number; ran: number; skipped: number; failed: number }>;
}> {
  const summary = {
    reactors_run: 0,
    events_examined: 0,
    reactions_ran: 0,
    reactions_skipped: 0,
    reactions_failed: 0,
    per_reactor: {} as Record<string, { examined: number; ran: number; skipped: number; failed: number }>,
  };

  if (!(await isFlagOn("reactor_enabled"))) {
    return summary;
  }

  const sinceMinutes = opts.sinceMinutesBack ?? 60;
  const limit = opts.limit ?? 50;
  const sinceTime = new Date(Date.now() - sinceMinutes * 60 * 1000).toISOString();

  for (const reactor of REGISTRY) {
    const events = await fetchPendingEvents(reactor.name, sinceTime, limit);
    summary.reactors_run++;
    const stats = { examined: events.length, ran: 0, skipped: 0, failed: 0 };
    for (const event of events) {
      const outcome = await processOne(reactor, event);
      summary.events_examined++;
      if (outcome === "ran") {
        stats.ran++;
        summary.reactions_ran++;
      } else if (outcome === "skipped") {
        stats.skipped++;
        summary.reactions_skipped++;
      } else {
        stats.failed++;
        summary.reactions_failed++;
      }
    }
    summary.per_reactor[reactor.name] = stats;
  }

  return summary;
}
