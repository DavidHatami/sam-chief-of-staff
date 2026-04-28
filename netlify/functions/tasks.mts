import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import {
  createTask as pgCreateTask,
  updateTaskByLegacyId as pgUpdateTaskByLegacyId,
  deleteTaskByLegacyId as pgDeleteTaskByLegacyId,
  isFlagOn,
  listTasksFromPG,
} from "../lib/sam-db.ts";

/**
 * Tasks API for SAM — Chief of Staff
 * Persistent task storage via Netlify Blobs
 *
 * GET    /api/tasks          → List all tasks
 * POST   /api/tasks          → Create a task
 * PUT    /api/tasks/:id      → Update a task
 * DELETE /api/tasks/:id      → Delete a task
 */

interface Task {
  id: string;
  title: string;
  description?: string;
  priority: "urgent" | "high" | "normal" | "low";
  status: "todo" | "in-progress" | "done" | "canceled" | "review" | "archived";
  category?: string;
  dueDate?: string;
  notes?: string;
  subtasks?: { title: string; done: boolean }[];
  createdAt: string;
  updatedAt: string;
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const path = url.pathname.replace("/api/tasks", "");
  const store = getStore({ name: "sam-tasks", consistency: "strong" });

  const headers = { "Content-Type": "application/json" };

  try {
    // ── LIST ALL TASKS ──
    if (req.method === "GET" && (path === "" || path === "/")) {
      // Phase 3 cutover: read from PG if the flag is set, fall back to blobs
      // on any error so SAM never goes down because PG had a hiccup.
      if (await isFlagOn("read_from_pg_tasks")) {
        const pgTasks = await listTasksFromPG();
        if (pgTasks !== null) {
          // Map PG row shape back to the wire shape the frontend expects
          const mapped: Task[] = pgTasks.map((r: any) => ({
            id: r.legacy_id || r.id,
            title: r.title,
            description: r.description || "",
            priority: r.priority,
            status: r.status,
            category: r.category || "",
            dueDate: r.due_date || "",
            notes: r.notes || "",
            subtasks: r.subtasks || [],
            createdAt: r.created_at,
            updatedAt: r.updated_at,
          }));
          return new Response(JSON.stringify({ tasks: mapped, source: "pg" }), { headers });
        }
        console.warn("[tasks] read_from_pg_tasks=on but PG read failed; falling back to blobs");
      }

      const result = await store.list();
      // Fetch all task blobs in parallel instead of sequentially
      const taskPromises = result.blobs.map(blob => store.get(blob.key, { type: "json" }));
      const rawTasks = await Promise.all(taskPromises);
      // Filter to proper task objects: not null, is an object, NOT an array
      // (arrays pass `typeof t === "object"` so they have to be excluded explicitly).
      // Without the !Array.isArray check, a corrupt blob containing an array of subtasks
      // surfaces as a single "task" that's actually a list — causing downstream parsers to crash.
      const tasks: Task[] = rawTasks.filter(t => t !== null && typeof t === "object" && !Array.isArray(t)) as Task[];
      // Sort: urgent first, then by createdAt descending
      const priorityOrder: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
      tasks.sort((a, b) => {
        if (a.status === "done" && b.status !== "done") return 1;
        if (a.status !== "done" && b.status === "done") return -1;
        const pa = priorityOrder[a.priority] ?? 2;
        const pb = priorityOrder[b.priority] ?? 2;
        if (pa !== pb) return pa - pb;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
      return new Response(JSON.stringify({ tasks }), { headers });
    }

    // ── CLEANUP ADMIN ENDPOINT ──
    // Scans every task blob, identifies malformed entries (not a proper task object —
    // null, primitive, or array), and removes them. Default is dry-run (reports what
    // would be removed); pass ?confirm=yes to actually delete.
    //
    // Why this exists: an old write path (likely a buggy bulk-import or subtasks-promotion)
    // left at least one blob whose content is an array of task-like objects instead of a
    // single task. The GET filter now rejects arrays, but the orphan blobs are still
    // sitting there consuming list-call latency and confusing any direct blob iteration.
    if ((req.method === "POST" || req.method === "GET") && path === "/cleanup") {
      const confirm = url.searchParams.get("confirm") === "yes";
      const result = await store.list();
      const inspections = await Promise.all(
        result.blobs.map(async (blob) => {
          const content = await store.get(blob.key, { type: "json" });
          let issue: string | null = null;
          if (content === null) issue = "blob is null";
          else if (typeof content !== "object") issue = `not an object (${typeof content})`;
          else if (Array.isArray(content)) issue = `is an array (${content.length} items)`;
          else if (typeof (content as any).id !== "string") issue = "missing string id field";
          return { key: blob.key, issue, sample: issue && content ? JSON.stringify(content).substring(0, 200) : null };
        })
      );
      const malformed = inspections.filter((i) => i.issue);
      if (!confirm) {
        return new Response(JSON.stringify({
          dryRun: true,
          totalBlobs: result.blobs.length,
          malformedCount: malformed.length,
          malformed,
          note: "Pass ?confirm=yes to actually delete these blobs",
        }), { headers });
      }
      // Confirmed — delete each malformed blob
      const deletions = await Promise.all(
        malformed.map(async (m) => {
          try {
            await store.delete(m.key);
            return { key: m.key, deleted: true };
          } catch (e: any) {
            return { key: m.key, deleted: false, error: String(e) };
          }
        })
      );
      return new Response(JSON.stringify({
        confirmed: true,
        totalBlobs: result.blobs.length,
        deleted: deletions.filter((d) => d.deleted).length,
        failures: deletions.filter((d) => !d.deleted),
      }), { headers });
    }

    // ── CREATE TASK ──
    if (req.method === "POST" && (path === "" || path === "/")) {
      const body = await req.json();
      const task: Task = {
        id: generateId(),
        title: body.title || "Untitled Task",
        description: body.description || "",
        priority: body.priority || "normal",
        status: body.status || "todo",
        category: body.category || "",
        dueDate: body.dueDate || "",
        notes: body.notes || "",
        subtasks: Array.isArray(body.subtasks) ? body.subtasks : [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      // Phase 4: blob writes are now gated. Default off — PG is the system of
      // record. Flip flag `legacy_blob_writes` to true in sam_meta to restore
      // dual storage behavior for rollback. When blob is off and PG fails,
      // the error surfaces to the caller instead of silently logging.
      const writeBlob = await isFlagOn("legacy_blob_writes");
      const writePG = await isFlagOn("dual_write_tasks");

      if (writeBlob) {
        await store.setJSON(task.id, task);
      }

      if (writePG) {
        try {
          await pgCreateTask({
            legacyId: task.id,
            title: task.title,
            description: task.description,
            priority: task.priority,
            status: task.status,
            category: task.category,
            dueDate: task.dueDate || null,
            notes: task.notes,
            subtasks: task.subtasks,
            source: "tasks_api",
          });
        } catch (e: any) {
          console.error("[tasks] PG create failed:", e?.message || e);
          if (!writeBlob) {
            return new Response(
              JSON.stringify({ error: "Task creation failed", detail: e?.message || String(e) }),
              { status: 500, headers }
            );
          }
        }
      }

      return new Response(JSON.stringify({ task }), { status: 201, headers });
    }

    // ── UPDATE TASK ──
    const idMatch = path.match(/^\/([a-z0-9]+)$/);
    if (req.method === "PUT" && idMatch) {
      const id = idMatch[1];
      const existing = await store.get(id, { type: "json" });
      if (!existing) {
        return new Response(JSON.stringify({ error: "Task not found" }), { status: 404, headers });
      }
      const body = await req.json();
      const updated: Task = {
        ...existing,
        ...body,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      };
      const writeBlobUpd = await isFlagOn("legacy_blob_writes");
      const writePGUpd = await isFlagOn("dual_write_tasks");

      if (writeBlobUpd) {
        await store.setJSON(id, updated);
      }

      if (writePGUpd) {
        try {
          await pgUpdateTaskByLegacyId(id, body, "tasks_api");
        } catch (e: any) {
          console.error("[tasks] PG update failed:", e?.message || e);
          if (!writeBlobUpd) {
            return new Response(
              JSON.stringify({ error: "Task update failed", detail: e?.message || String(e) }),
              { status: 500, headers }
            );
          }
        }
      }

      return new Response(JSON.stringify({ task: updated }), { headers });
    }

    // ── DELETE TASK ──
    if (req.method === "DELETE" && idMatch) {
      const id = idMatch[1];
      const existing = await store.get(id, { type: "json" });
      if (!existing) {
        return new Response(JSON.stringify({ error: "Task not found" }), { status: 404, headers });
      }
      const writeBlobDel = await isFlagOn("legacy_blob_writes");
      const writePGDel = await isFlagOn("dual_write_tasks");

      if (writeBlobDel) {
        await store.delete(id);
      }

      if (writePGDel) {
        try {
          await pgDeleteTaskByLegacyId(id, "tasks_api");
        } catch (e: any) {
          console.error("[tasks] PG delete failed:", e?.message || e);
          if (!writeBlobDel) {
            return new Response(
              JSON.stringify({ error: "Task delete failed", detail: e?.message || String(e) }),
              { status: 500, headers }
            );
          }
        }
      }

      return new Response(JSON.stringify({ deleted: true, id }), { headers });
    }

    return new Response(JSON.stringify({ error: "Unknown tasks endpoint" }), { status: 404, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers });
  }
};

export const config: Config = {
  path: ["/api/tasks", "/api/tasks/*"],
};
