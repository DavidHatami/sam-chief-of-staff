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

    // ── COMPRESS SINGLE INSTRUCTION (via Gemini Flash — free) ──
    if (path === "compress" && req.method === "POST") {
      const body = await req.json();
      const { content, instructionId } = body;
      const textToCompress = content || "";

      if (!textToCompress || textToCompress.length < 30) {
        return new Response(JSON.stringify({ error: "Content too short to compress" }), { status: 400, headers });
      }

      const GEMINI_KEY = Netlify.env.get("GEMINI_API_KEY");
      if (!GEMINI_KEY) {
        return new Response(JSON.stringify({ error: "Gemini API key needed for compression (it's free). Add GEMINI_API_KEY." }), { status: 500, headers });
      }

      const compressPrompt = `You are a prompt compression engine. Compress the following instruction text to the MINIMUM number of characters while preserving 100% of the meaning, specificity, names, numbers, rules, and intent. Use telegraphic style — remove all filler words, articles, pleasantries, and conversational padding. Keep proper nouns, exact numbers, specific rules, and technical terms intact. Do NOT summarize or generalize — compress.

Original (${textToCompress.length} chars):
${textToCompress}

Compressed version (aim for 40-60% reduction):`;

      try {
        const gResp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: compressPrompt }] }],
              generationConfig: { maxOutputTokens: 1024, temperature: 0.2 },
            }),
          }
        );

        if (!gResp.ok) {
          const errText = await gResp.text();
          return new Response(JSON.stringify({ error: "Gemini error: " + errText.substring(0, 200) }), { status: 500, headers });
        }

        const gData = await gResp.json();
        const compressed = gData.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("").trim() || "";

        if (!compressed) {
          return new Response(JSON.stringify({ error: "Gemini returned empty response" }), { status: 500, headers });
        }

        const savings = Math.round((1 - compressed.length / textToCompress.length) * 100);

        return new Response(JSON.stringify({
          success: true,
          original: textToCompress,
          compressed,
          originalChars: textToCompress.length,
          compressedChars: compressed.length,
          savings: savings + "%",
          originalTokens: Math.ceil(textToCompress.length / 4),
          compressedTokens: Math.ceil(compressed.length / 4),
          instructionId: instructionId || null,
        }), { headers });
      } catch (e) {
        return new Response(JSON.stringify({ error: "Compression failed: " + String(e) }), { status: 500, headers });
      }
    }

    // ── COMPRESS ALL ENABLED INSTRUCTIONS ──
    if (path === "compress-all" && req.method === "POST") {
      const GEMINI_KEY = Netlify.env.get("GEMINI_API_KEY");
      if (!GEMINI_KEY) {
        return new Response(JSON.stringify({ error: "Gemini API key needed" }), { status: 500, headers });
      }

      const all = await loadAll();
      const enabled = all.filter(i => i.enabled && i.content.length > 50);
      const results: Array<{ id: string; title: string; originalChars: number; compressedChars: number; savings: string }> = [];

      for (const inst of enabled) {
        try {
          const gResp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ role: "user", parts: [{ text: `Compress this instruction to minimum characters while preserving 100% of meaning, names, numbers, rules. Telegraphic style. No filler. Keep specifics.\n\nOriginal:\n${inst.content}\n\nCompressed:` }] }],
                generationConfig: { maxOutputTokens: 512, temperature: 0.2 },
              }),
            }
          );
          if (gResp.ok) {
            const gData = await gResp.json();
            const compressed = gData.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("").trim() || "";
            if (compressed && compressed.length < inst.content.length) {
              const origLen = inst.content.length;
              inst.content = compressed;
              inst.updated = new Date().toISOString();
              const savings = Math.round((1 - compressed.length / origLen) * 100);
              results.push({ id: inst.id, title: inst.title, originalChars: origLen, compressedChars: compressed.length, savings: savings + "%" });
            }
          }
        } catch (e) { /* skip failed ones */ }
      }

      await saveAll(all);
      const totalOriginal = results.reduce((s, r) => s + r.originalChars, 0);
      const totalCompressed = results.reduce((s, r) => s + r.compressedChars, 0);

      return new Response(JSON.stringify({
        success: true,
        compressed: results.length,
        skipped: enabled.length - results.length,
        totalOriginalChars: totalOriginal,
        totalCompressedChars: totalCompressed,
        totalSavings: totalOriginal > 0 ? Math.round((1 - totalCompressed / totalOriginal) * 100) + "%" : "0%",
        details: results,
      }), { headers });
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
