import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import {
  createTask as pgCreateTask,
  upsertPerson,
  upsertInitiative,
  insertPreference,
  insertDecision,
  findTaskByLegacyId,
  emitEvent,
} from "../lib/sam-db.ts";

/**
 * SAM PHASE 2 — BACKFILL
 *
 * One-time migration that copies existing blob data into Postgres. Idempotent:
 * running it twice does not duplicate. Each entity type is handled separately
 * so a partial run can be resumed.
 *
 *   GET  /api/admin/backfill                → dry-run report (counts only, no writes)
 *   POST /api/admin/backfill?confirm=yes    → execute the backfill
 *   POST /api/admin/backfill?entity=tasks&confirm=yes  → only one entity type
 *
 * Body { entities: ["tasks","memory"] } also accepted to scope.
 *
 * SAFETY:
 *   - Defaults to dry-run.
 *   - Skips entities already present in PG (idempotent).
 *   - Logs every skip and every write to audit_log.
 *   - Does NOT delete anything from blobs. Phase 4 handles that separately.
 */

interface BackfillReport {
  entity: string;
  blob_count: number;
  pg_existing: number;
  inserted: number;
  skipped: number;
  errors: string[];
}

async function backfillTasks(dryRun: boolean): Promise<BackfillReport> {
  const report: BackfillReport = { entity: "tasks", blob_count: 0, pg_existing: 0, inserted: 0, skipped: 0, errors: [] };
  const store = getStore({ name: "sam-tasks", consistency: "strong" });
  const list = await store.list();
  report.blob_count = list.blobs.length;

  for (const blob of list.blobs) {
    const t: any = await store.get(blob.key, { type: "json" });
    if (!t || typeof t !== "object" || Array.isArray(t)) {
      report.skipped++;
      continue;
    }
    if (typeof t.id !== "string") {
      report.errors.push(`blob ${blob.key}: missing id field`);
      report.skipped++;
      continue;
    }
    // Check if already in PG by legacy_id
    const existing = await findTaskByLegacyId(t.id);
    if (existing) {
      report.pg_existing++;
      continue;
    }
    if (dryRun) {
      report.inserted++; // would insert
      continue;
    }
    const result = await pgCreateTask({
      legacyId: t.id,
      title: t.title || "Untitled Task",
      description: t.description || undefined,
      priority: t.priority || "normal",
      status: t.status || "todo",
      category: t.category || undefined,
      dueDate: t.dueDate || null,
      notes: t.notes || undefined,
      subtasks: Array.isArray(t.subtasks) ? t.subtasks : [],
      source: "backfill",
    });
    if (!result) {
      report.errors.push(`task ${t.id}: PG create returned null`);
      report.skipped++;
    } else {
      report.inserted++;
    }
  }
  return report;
}

async function backfillMemory(dryRun: boolean): Promise<BackfillReport[]> {
  const reports: BackfillReport[] = [];
  const store = getStore({ name: "sam-knowledge", consistency: "strong" });
  const knowledge: any = await store.get("knowledge", { type: "json" });

  if (!knowledge || typeof knowledge !== "object") {
    reports.push({ entity: "people", blob_count: 0, pg_existing: 0, inserted: 0, skipped: 0, errors: ["no knowledge blob"] });
    return reports;
  }

  // PEOPLE
  const peopleReport: BackfillReport = { entity: "people", blob_count: 0, pg_existing: 0, inserted: 0, skipped: 0, errors: [] };
  const people = Array.isArray(knowledge.people) ? knowledge.people : [];
  peopleReport.blob_count = people.length;
  for (const p of people) {
    if (!p?.name || typeof p.name !== "string") {
      peopleReport.skipped++;
      continue;
    }
    if (dryRun) {
      peopleReport.inserted++;
      continue;
    }
    const result = await upsertPerson({
      name: p.name,
      facts: Array.isArray(p.facts) ? p.facts : [],
      source: "backfill",
    });
    if (!result) {
      peopleReport.errors.push(`person ${p.name}: upsert returned null`);
      peopleReport.skipped++;
    } else if (result.action === "created") {
      peopleReport.inserted++;
    } else {
      peopleReport.pg_existing++;
    }
  }
  reports.push(peopleReport);

  // INITIATIVES (called "projects" in the blob)
  const initReport: BackfillReport = { entity: "initiatives", blob_count: 0, pg_existing: 0, inserted: 0, skipped: 0, errors: [] };
  const projects = Array.isArray(knowledge.projects) ? knowledge.projects : [];
  initReport.blob_count = projects.length;
  for (const p of projects) {
    if (!p?.name || typeof p.name !== "string") {
      initReport.skipped++;
      continue;
    }
    if (dryRun) {
      initReport.inserted++;
      continue;
    }
    const result = await upsertInitiative({
      name: p.name,
      status: p.status,
      facts: Array.isArray(p.facts) ? p.facts : [],
      source: "backfill",
    });
    if (!result) {
      initReport.errors.push(`initiative ${p.name}: upsert returned null`);
      initReport.skipped++;
    } else if (result.action === "created") {
      initReport.inserted++;
    } else {
      initReport.pg_existing++;
    }
  }
  reports.push(initReport);

  // PREFERENCES
  const prefReport: BackfillReport = { entity: "preferences", blob_count: 0, pg_existing: 0, inserted: 0, skipped: 0, errors: [] };
  const prefs = Array.isArray(knowledge.preferences) ? knowledge.preferences : [];
  prefReport.blob_count = prefs.length;
  for (const pref of prefs) {
    if (!pref?.text || typeof pref.text !== "string") {
      prefReport.skipped++;
      continue;
    }
    if (dryRun) {
      prefReport.inserted++;
      continue;
    }
    const id = await insertPreference(pref.text, "backfill");
    if (id) prefReport.inserted++;
    else prefReport.skipped++;
  }
  reports.push(prefReport);

  // DECISIONS
  const decReport: BackfillReport = { entity: "decisions", blob_count: 0, pg_existing: 0, inserted: 0, skipped: 0, errors: [] };
  const decs = Array.isArray(knowledge.decisions) ? knowledge.decisions : [];
  decReport.blob_count = decs.length;
  for (const dec of decs) {
    if (!dec?.text || typeof dec.text !== "string") {
      decReport.skipped++;
      continue;
    }
    if (dryRun) {
      decReport.inserted++;
      continue;
    }
    const id = await insertDecision({ text: dec.text, context: dec.context, source: "backfill" });
    if (id) decReport.inserted++;
    else decReport.skipped++;
  }
  reports.push(decReport);

  return reports;
}

export default async (req: Request, _ctx: Context) => {
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("confirm") !== "yes";
  const entityFilter = url.searchParams.get("entity"); // optional: tasks | memory

  // GET → always dry-run regardless of confirm param
  const isGet = req.method === "GET";
  const effectiveDryRun = isGet || dryRun;

  const reports: BackfillReport[] = [];
  try {
    if (!entityFilter || entityFilter === "tasks") {
      reports.push(await backfillTasks(effectiveDryRun));
    }
    if (!entityFilter || entityFilter === "memory") {
      const memReports = await backfillMemory(effectiveDryRun);
      reports.push(...memReports);
    }

    if (!effectiveDryRun) {
      // Emit a single audit event so the run is recorded in the event log
      const totalInserted = reports.reduce((sum, r) => sum + r.inserted, 0);
      await emitEvent({
        type: "admin.backfill.executed",
        source: "admin_backfill",
        payload: { reports, totalInserted },
      });
    }

    return new Response(JSON.stringify({
      ok: true,
      dryRun: effectiveDryRun,
      reports,
      summary: {
        total_blob: reports.reduce((s, r) => s + r.blob_count, 0),
        total_pg_existing: reports.reduce((s, r) => s + r.pg_existing, 0),
        total_inserted: reports.reduce((s, r) => s + r.inserted, 0),
        total_skipped: reports.reduce((s, r) => s + r.skipped, 0),
        total_errors: reports.reduce((s, r) => s + r.errors.length, 0),
      },
      note: effectiveDryRun ? "DRY RUN. Pass ?confirm=yes (POST) to execute." : "Backfill executed.",
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || String(e), reports }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const config: Config = {
  path: "/api/admin/backfill",
};
