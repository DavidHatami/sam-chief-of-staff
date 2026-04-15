import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

/**
 * SAM Projects — Knowledge Workspace System
 *
 * GET    /api/projects              → List all projects
 * GET    /api/projects/:id          → Get full project with knowledge
 * POST   /api/projects              → Create new project
 * PUT    /api/projects/:id          → Update project metadata/prompt/notes
 * DELETE /api/projects/:id          → Archive project
 * POST   /api/projects/:id/kb       → Add knowledge item
 * DELETE /api/projects/:id/kb/:kbId → Remove knowledge item
 * GET    /api/projects/:id/context  → Get AI injection context (prompt + knowledge)
 */

interface KnowledgeItem {
  id: string;
  title: string;
  type: "text" | "url" | "note";
  content: string;
  added: string;
  charCount: number;
}

interface Project {
  id: string;
  name: string;
  description: string;
  category: string;
  status: "active" | "paused" | "completed" | "archived";
  priority: "urgent" | "high" | "medium" | "low";
  systemPrompt: string;
  tags: string[];
  notes: string;
  knowledge: KnowledgeItem[];
  created: string;
  updated: string;
}

interface ProjectIndex {
  id: string;
  name: string;
  description: string;
  category: string;
  status: string;
  priority: string;
  tags: string[];
  knowledgeCount: number;
  totalChars: number;
  created: string;
  updated: string;
}

function genId(prefix: string): string {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const path = url.pathname.replace("/api/projects", "").replace(/^\/+|\/+$/g, "");
  const segments = path.split("/").filter(Boolean);
  const headers = { "Content-Type": "application/json" };
  const store = getStore({ name: "sam-projects", consistency: "strong" });

  try {
    // ── LIST ALL PROJECTS ──
    if (segments.length === 0 && req.method === "GET") {
      const index: ProjectIndex[] = (await store.get("index", { type: "json" })) || [];
      return new Response(JSON.stringify({ projects: index }), { headers });
    }

    // ── CREATE PROJECT ──
    if (segments.length === 0 && req.method === "POST") {
      const body = await req.json();
      const { name, description, category, priority, systemPrompt, tags, notes } = body;
      if (!name) {
        return new Response(JSON.stringify({ error: "Project name required" }), { status: 400, headers });
      }

      const id = genId("proj");
      const now = new Date().toISOString();
      const project: Project = {
        id,
        name,
        description: description || "",
        category: category || "general",
        status: "active",
        priority: priority || "medium",
        systemPrompt: systemPrompt || "",
        tags: tags || [],
        notes: notes || "",
        knowledge: [],
        created: now,
        updated: now,
      };

      // Save full project
      await store.set(`proj-${id}`, JSON.stringify(project));

      // Update index
      const index: ProjectIndex[] = (await store.get("index", { type: "json" })) || [];
      index.unshift({
        id, name, description: project.description, category: project.category,
        status: project.status, priority: project.priority, tags: project.tags,
        knowledgeCount: 0, totalChars: 0, created: now, updated: now,
      });
      await store.set("index", JSON.stringify(index));

      return new Response(JSON.stringify({ success: true, project }), { headers });
    }

    // ── GET PROJECT CONTEXT (for AI injection) ──
    if (segments.length === 2 && segments[1] === "context" && req.method === "GET") {
      const projId = segments[0];
      const raw = await store.get(`proj-${projId}`);
      if (!raw) return new Response(JSON.stringify({ error: "Project not found" }), { status: 404, headers });
      const project: Project = JSON.parse(raw);

      // Build context string for AI injection
      let ctx = "";
      if (project.systemPrompt) {
        ctx += `[PROJECT INSTRUCTIONS]\n${project.systemPrompt}\n\n`;
      }
      ctx += `[PROJECT: ${project.name}]\n`;
      if (project.description) ctx += `Description: ${project.description}\n`;
      if (project.category) ctx += `Category: ${project.category}\n`;
      if (project.notes) ctx += `Notes: ${project.notes}\n`;

      if (project.knowledge.length > 0) {
        ctx += `\n[KNOWLEDGE BASE — ${project.knowledge.length} items]\n`;
        project.knowledge.forEach((kb, i) => {
          // Truncate to 2000 chars per item to keep context manageable
          const content = kb.content.length > 2000 ? kb.content.substring(0, 2000) + "..." : kb.content;
          ctx += `\n--- ${kb.title} (${kb.type}) ---\n${content}\n`;
        });
      }

      return new Response(JSON.stringify({
        context: ctx,
        projectName: project.name,
        systemPrompt: project.systemPrompt,
        knowledgeCount: project.knowledge.length,
      }), { headers });
    }

    // ── GET SINGLE PROJECT ──
    if (segments.length === 1 && req.method === "GET") {
      const projId = segments[0];
      const raw = await store.get(`proj-${projId}`);
      if (!raw) return new Response(JSON.stringify({ error: "Project not found" }), { status: 404, headers });
      const project: Project = JSON.parse(raw);
      return new Response(JSON.stringify({ project }), { headers });
    }

    // ── UPDATE PROJECT ──
    if (segments.length === 1 && req.method === "PUT") {
      const projId = segments[0];
      const raw = await store.get(`proj-${projId}`);
      if (!raw) return new Response(JSON.stringify({ error: "Project not found" }), { status: 404, headers });
      const project: Project = JSON.parse(raw);
      const body = await req.json();

      // Update fields if provided
      if (body.name !== undefined) project.name = body.name;
      if (body.description !== undefined) project.description = body.description;
      if (body.category !== undefined) project.category = body.category;
      if (body.status !== undefined) project.status = body.status;
      if (body.priority !== undefined) project.priority = body.priority;
      if (body.systemPrompt !== undefined) project.systemPrompt = body.systemPrompt;
      if (body.tags !== undefined) project.tags = body.tags;
      if (body.notes !== undefined) project.notes = body.notes;
      project.updated = new Date().toISOString();

      await store.set(`proj-${projId}`, JSON.stringify(project));

      // Update index
      const index: ProjectIndex[] = (await store.get("index", { type: "json" })) || [];
      const idx = index.findIndex(p => p.id === projId);
      if (idx >= 0) {
        index[idx].name = project.name;
        index[idx].description = project.description;
        index[idx].category = project.category;
        index[idx].status = project.status;
        index[idx].priority = project.priority;
        index[idx].tags = project.tags;
        index[idx].updated = project.updated;
        await store.set("index", JSON.stringify(index));
      }

      return new Response(JSON.stringify({ success: true, project }), { headers });
    }

    // ── DELETE (ARCHIVE) PROJECT ──
    if (segments.length === 1 && req.method === "DELETE") {
      const projId = segments[0];
      const raw = await store.get(`proj-${projId}`);
      if (!raw) return new Response(JSON.stringify({ error: "Project not found" }), { status: 404, headers });
      const project: Project = JSON.parse(raw);
      project.status = "archived";
      project.updated = new Date().toISOString();
      await store.set(`proj-${projId}`, JSON.stringify(project));

      const index: ProjectIndex[] = (await store.get("index", { type: "json" })) || [];
      const idx = index.findIndex(p => p.id === projId);
      if (idx >= 0) {
        index[idx].status = "archived";
        index[idx].updated = project.updated;
        await store.set("index", JSON.stringify(index));
      }

      return new Response(JSON.stringify({ success: true, archived: projId }), { headers });
    }

    // ── ADD KNOWLEDGE ITEM ──
    if (segments.length === 2 && segments[1] === "kb" && req.method === "POST") {
      const projId = segments[0];
      const raw = await store.get(`proj-${projId}`);
      if (!raw) return new Response(JSON.stringify({ error: "Project not found" }), { status: 404, headers });
      const project: Project = JSON.parse(raw);
      const body = await req.json();

      const { title, content, type } = body;
      if (!title || !content) {
        return new Response(JSON.stringify({ error: "Title and content required" }), { status: 400, headers });
      }

      const kbItem: KnowledgeItem = {
        id: genId("kb"),
        title,
        type: type || "text",
        content,
        added: new Date().toISOString(),
        charCount: content.length,
      };

      project.knowledge.push(kbItem);
      project.updated = new Date().toISOString();
      await store.set(`proj-${projId}`, JSON.stringify(project));

      // Update index counts
      const index: ProjectIndex[] = (await store.get("index", { type: "json" })) || [];
      const idx = index.findIndex(p => p.id === projId);
      if (idx >= 0) {
        index[idx].knowledgeCount = project.knowledge.length;
        index[idx].totalChars = project.knowledge.reduce((s, k) => s + k.charCount, 0);
        index[idx].updated = project.updated;
        await store.set("index", JSON.stringify(index));
      }

      return new Response(JSON.stringify({ success: true, item: kbItem, total: project.knowledge.length }), { headers });
    }

    // ── DELETE KNOWLEDGE ITEM ──
    if (segments.length === 3 && segments[1] === "kb" && req.method === "DELETE") {
      const projId = segments[0];
      const kbId = segments[2];
      const raw = await store.get(`proj-${projId}`);
      if (!raw) return new Response(JSON.stringify({ error: "Project not found" }), { status: 404, headers });
      const project: Project = JSON.parse(raw);

      project.knowledge = project.knowledge.filter(k => k.id !== kbId);
      project.updated = new Date().toISOString();
      await store.set(`proj-${projId}`, JSON.stringify(project));

      const index: ProjectIndex[] = (await store.get("index", { type: "json" })) || [];
      const idx = index.findIndex(p => p.id === projId);
      if (idx >= 0) {
        index[idx].knowledgeCount = project.knowledge.length;
        index[idx].totalChars = project.knowledge.reduce((s, k) => s + k.charCount, 0);
        index[idx].updated = project.updated;
        await store.set("index", JSON.stringify(index));
      }

      return new Response(JSON.stringify({ success: true, deleted: kbId, remaining: project.knowledge.length }), { headers });
    }

    return new Response(JSON.stringify({ error: "Unknown projects endpoint: " + path }), { status: 404, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers });
  }
};

export const config: Config = {
  path: ["/api/projects", "/api/projects/*"],
};
