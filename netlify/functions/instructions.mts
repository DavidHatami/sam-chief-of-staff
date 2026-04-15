import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

/**
 * SAM Instructions — Permanent Memory System
 *
 * GET    /api/instructions           → Get all instructions
 * POST   /api/instructions           → Add new instruction
 * PUT    /api/instructions/:id       → Update instruction (content, enabled, order)
 * DELETE /api/instructions/:id       → Delete instruction
 * GET    /api/instructions/context   → Get compiled context string for AI injection
 *
 * This is SAM's long-term memory. Instructions persist across all conversations
 * and get injected into every AI call as part of the system prompt.
 */

interface Instruction {
  id: string;
  category: string;
  title: string;
  content: string;
  enabled: boolean;
  order: number;
  created: string;
  updated: string;
}

function genId(): string {
  return "inst_" + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const path = url.pathname.replace("/api/instructions", "").replace(/^\/+|\/+$/g, "");
  const headers = { "Content-Type": "application/json" };
  const store = getStore({ name: "sam-instructions", consistency: "strong" });

  try {
    // Helper: load all instructions
    async function loadAll(): Promise<Instruction[]> {
      const raw = await store.get("all", { type: "json" });
      return (raw as Instruction[]) || [];
    }

    async function saveAll(items: Instruction[]): Promise<void> {
      await store.set("all", JSON.stringify(items));
    }

    // ── GET COMPILED CONTEXT (for AI injection) ──
    if (path === "context" && req.method === "GET") {
      const all = await loadAll();
      const enabled = all.filter(i => i.enabled).sort((a, b) => a.order - b.order);

      if (!enabled.length) {
        return new Response(JSON.stringify({ context: "", count: 0 }), { headers });
      }

      // Group by category
      const groups: Record<string, Instruction[]> = {};
      enabled.forEach(i => {
        const cat = i.category || "general";
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(i);
      });

      const categoryLabels: Record<string, string> = {
        identity: "WHO I AM",
        preferences: "MY PREFERENCES & STYLE",
        clients: "CURRENT CLIENTS & ENGAGEMENTS",
        rules: "AI BEHAVIOR RULES",
        knowledge: "DOMAIN KNOWLEDGE & CONTEXT",
        contacts: "KEY CONTACTS & RELATIONSHIPS",
        schedule: "SCHEDULE & AVAILABILITY",
        custom: "ADDITIONAL INSTRUCTIONS",
        general: "GENERAL",
      };

      let ctx = "[SAM PERMANENT INSTRUCTIONS — Dr. Hatami's Standing Orders]\n";
      for (const [cat, items] of Object.entries(groups)) {
        const label = categoryLabels[cat] || cat.toUpperCase();
        ctx += `\n── ${label} ──\n`;
        items.forEach(i => {
          ctx += `${i.content}\n`;
        });
      }

      const charCount = ctx.length;
      const tokenEstimate = Math.ceil(charCount / 4);

      return new Response(JSON.stringify({
        context: ctx,
        count: enabled.length,
        totalEnabled: enabled.length,
        totalAll: all.length,
        charCount,
        tokenEstimate,
      }), { headers });
    }

    // ── LIST ALL INSTRUCTIONS ──
    if (!path && req.method === "GET") {
      const all = await loadAll();
      const enabled = all.filter(i => i.enabled).length;
      const charCount = all.filter(i => i.enabled).reduce((s, i) => s + i.content.length, 0);
      return new Response(JSON.stringify({
        instructions: all.sort((a, b) => a.order - b.order),
        stats: { total: all.length, enabled, disabled: all.length - enabled, charCount, tokenEstimate: Math.ceil(charCount / 4) },
      }), { headers });
    }

    // ── ADD INSTRUCTION ──
    if (!path && req.method === "POST") {
      const body = await req.json();
      const { category, title, content } = body;
      if (!title || !content) {
        return new Response(JSON.stringify({ error: "Title and content required" }), { status: 400, headers });
      }

      const all = await loadAll();
      const inst: Instruction = {
        id: genId(),
        category: category || "general",
        title,
        content,
        enabled: true,
        order: all.length,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      };
      all.push(inst);
      await saveAll(all);

      return new Response(JSON.stringify({ success: true, instruction: inst }), { headers });
    }

    // ── UPDATE INSTRUCTION ──
    if (path && req.method === "PUT") {
      const id = path;
      const all = await loadAll();
      const idx = all.findIndex(i => i.id === id);
      if (idx < 0) {
        return new Response(JSON.stringify({ error: "Instruction not found" }), { status: 404, headers });
      }

      const body = await req.json();
      if (body.title !== undefined) all[idx].title = body.title;
      if (body.content !== undefined) all[idx].content = body.content;
      if (body.category !== undefined) all[idx].category = body.category;
      if (body.enabled !== undefined) all[idx].enabled = body.enabled;
      if (body.order !== undefined) all[idx].order = body.order;
      all[idx].updated = new Date().toISOString();

      await saveAll(all);
      return new Response(JSON.stringify({ success: true, instruction: all[idx] }), { headers });
    }

    // ── DELETE INSTRUCTION ──
    if (path && req.method === "DELETE") {
      const id = path;
      let all = await loadAll();
      const before = all.length;
      all = all.filter(i => i.id !== id);
      if (all.length === before) {
        return new Response(JSON.stringify({ error: "Instruction not found" }), { status: 404, headers });
      }
      // Re-order
      all.forEach((inst, i) => { inst.order = i; });
      await saveAll(all);
      return new Response(JSON.stringify({ success: true, deleted: id, remaining: all.length }), { headers });
    }

    return new Response(JSON.stringify({ error: "Unknown instructions endpoint" }), { status: 404, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers });
  }
};

export const config: Config = {
  path: ["/api/instructions", "/api/instructions/*"],
};
