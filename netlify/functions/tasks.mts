import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

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
  status: "todo" | "in-progress" | "done" | "canceled";
  category?: string;
  dueDate?: string;
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
      const result = await store.list();
      const tasks: Task[] = [];
      for (const blob of result.blobs) {
        const task = await store.get(blob.key, { type: "json" });
        if (task) tasks.push(task);
      }
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
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await store.setJSON(task.id, task);
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
      await store.setJSON(id, updated);
      return new Response(JSON.stringify({ task: updated }), { headers });
    }

    // ── DELETE TASK ──
    if (req.method === "DELETE" && idMatch) {
      const id = idMatch[1];
      await store.delete(id);
      return new Response(JSON.stringify({ deleted: true }), { headers });
    }

    return new Response(JSON.stringify({ error: "Unknown tasks endpoint" }), { status: 404, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers });
  }
};

export const config: Config = {
  path: "/api/tasks/*",
};
