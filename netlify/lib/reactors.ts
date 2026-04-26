/**
 * SAM REACTORS — concrete implementations
 *
 * Each reactor is a small module that subscribes to a slice of the event
 * stream and produces a side effect. Adding a new behavior to SAM means
 * adding a reactor here and registering it. No module-to-module wiring,
 * no closed loops.
 *
 * Phase 5 ships with one reactor:
 *   - audit_logger: mirrors every event into audit_log so we have a
 *     human-readable record-level history. Different from the events
 *     table which is domain-level ("task.created"); audit_log captures
 *     before/after state for forensic queries like "show me everything
 *     that touched this person between Tuesday and Thursday".
 *
 * Future reactors (registered when their phase lands):
 *   - link_people_to_tasks: when task.created with a known name in title,
 *     insert into task_people junction
 *   - update_last_touched: when a person is mentioned in any event,
 *     bump their last_touched_at timestamp
 *   - cost_throttle: when daily model_costs sum exceeds the ceiling,
 *     emit cost.ceiling_hit which other reactors gate on
 */

import { registerReactor, type Reactor } from "./reactor.ts";
import { getDb } from "./sam-db.ts";

const auditLogger: Reactor = {
  name: "audit_logger",
  // Subscribes to everything except its own audit emissions and reactor
  // bookkeeping events that would create infinite loops.
  interestedIn: (eventType: string) => {
    if (eventType.startsWith("audit.")) return false;
    if (eventType.startsWith("reactor.")) return false;
    return true;
  },
  async run(ctx) {
    const db = getDb();
    if (!db) throw new Error("DB unavailable");
    const { event } = ctx;
    // Build a compact human-readable summary of what changed
    const action = event.type;
    const before = event.payload?.before ?? null;
    const after = event.payload?.patch ?? event.payload?.after ?? event.payload ?? null;
    await db.from("audit_log").insert({
      actor: event.source ?? "system",
      action,
      entity_type: event.entity_type,
      entity_id: event.entity_id,
      before,
      after,
      source: `reactor:audit_logger`,
    });
    return { result: { logged: true, action } };
  },
};

registerReactor(auditLogger);

export { auditLogger };
