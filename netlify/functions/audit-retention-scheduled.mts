import type { Config } from "@netlify/functions";
import { getDb, emitEvent } from "../lib/sam-db.ts";

/**
 * Phase 9: audit_log retention.
 *
 * Runs daily at 04:00 UTC. Deletes audit_log rows older than 90 days.
 * Records a domain event with the count so the operation is itself auditable.
 *
 * The events table is NEVER cleaned — events are durable history. audit_log
 * is the high-volume mirror; trimming it is fine because the events table
 * still has the source of truth.
 *
 * 90-day window matches typical SOC 2 Type II audit windows. Adjust if
 * your retention policy differs.
 */

const RETENTION_DAYS = 90;

export default async () => {
  const db = getDb();
  if (!db) {
    console.error("[audit-retention] DB unavailable");
    return new Response("db unavailable", { status: 500 });
  }

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  try {
    // Count first so we know what we're deleting (and so the event payload is informative)
    const { count: pre, error: countErr } = await db
      .from("audit_log")
      .select("*", { count: "exact", head: true })
      .lt("occurred_at", cutoff);
    if (countErr) throw new Error(`count failed: ${countErr.message}`);

    if (!pre || pre === 0) {
      console.log(`[audit-retention] nothing to delete older than ${cutoff}`);
      return new Response("nothing to clean", { status: 200 });
    }

    const { error: delErr } = await db.from("audit_log").delete().lt("occurred_at", cutoff);
    if (delErr) throw new Error(`delete failed: ${delErr.message}`);

    await emitEvent({
      type: "admin.audit_retention.executed",
      source: "audit_retention_cron",
      payload: { rows_deleted: pre, cutoff, retention_days: RETENTION_DAYS },
    });

    console.log(`[audit-retention] deleted ${pre} rows older than ${cutoff}`);
    return new Response(`deleted ${pre}`, { status: 200 });
  } catch (e: any) {
    console.error("[audit-retention] failed:", e?.message || e);
    return new Response(`error: ${e?.message || e}`, { status: 500 });
  }
};

export const config: Config = {
  schedule: "0 4 * * *", // daily at 04:00 UTC
};
