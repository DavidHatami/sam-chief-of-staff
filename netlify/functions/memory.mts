import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { extractFromTurns, EMPTY_KNOWLEDGE, type Knowledge } from "../lib/memory-extract.ts";

/**
 * SAM STANDING KNOWLEDGE — read, manually trigger extraction, or clear
 *
 *   GET    /api/memory                  → return current knowledge corpus
 *   POST   /api/memory/extract          → run extraction NOW over recent turns
 *   DELETE /api/memory?confirm=yes      → clear all knowledge
 *   PUT    /api/memory                  → manually edit knowledge (admin override)
 *
 * Extraction is normally automatic (memory-extract-scheduled cron, every 6 hours).
 * The POST trigger here is for "I just told SAM 5 important things, distill them now."
 */

const TURNS_PER_EXTRACTION = 30;

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const knowStore = getStore({ name: "sam-knowledge", consistency: "strong" });

  if (req.method === "GET") {
    try {
      const know = ((await knowStore.get("knowledge", { type: "json" })) as Knowledge | null) || EMPTY_KNOWLEDGE;
      return new Response(JSON.stringify(know), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "private, max-age=30, stale-while-revalidate=120",
        },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e?.message || String(e) }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }
  }

  if (req.method === "POST" && url.pathname.endsWith("/extract")) {
    // Run extraction now
    try {
      const histStore = getStore({ name: "sam-chat-history", consistency: "strong" });
      const turns = ((await histStore.get("turns", { type: "json" })) as Array<{ role: string; content: string; at?: string }> | null) || [];
      if (turns.length === 0) {
        return new Response(JSON.stringify({ error: "No chat history to extract from" }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }

      const existing = ((await knowStore.get("knowledge", { type: "json" })) as Knowledge | null) || EMPTY_KNOWLEDGE;

      // Determine which turns to feed: anything newer than lastExtractedFromAt,
      // or last TURNS_PER_EXTRACTION if no prior extraction.
      let recentTurns = turns;
      if (existing.lastExtractedFromAt) {
        const cutoff = existing.lastExtractedFromAt;
        recentTurns = turns.filter((t) => t.at && t.at > cutoff);
        // If no truly new turns, fall back to last 10 for a "re-distill" pass
        if (recentTurns.length === 0) {
          recentTurns = turns.slice(-10);
        }
      } else {
        // First extraction — go back further
        recentTurns = turns.slice(-TURNS_PER_EXTRACTION);
      }

      const anthropicKey = Netlify.env.get("ANTHROPIC_API_KEY");
      if (!anthropicKey) {
        return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY missing" }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }

      const updated = await extractFromTurns(recentTurns, existing, anthropicKey);
      await knowStore.setJSON("knowledge", updated);

      return new Response(JSON.stringify({
        ok: true,
        turnsExtractedFrom: recentTurns.length,
        beforeCounts: {
          people: existing.people.length, projects: existing.projects.length,
          preferences: existing.preferences.length, decisions: existing.decisions.length,
        },
        afterCounts: {
          people: updated.people.length, projects: updated.projects.length,
          preferences: updated.preferences.length, decisions: updated.decisions.length,
        },
      }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e?.message || String(e) }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }
  }

  if (req.method === "DELETE") {
    const confirm = url.searchParams.get("confirm");
    if (confirm !== "yes") {
      return new Response(JSON.stringify({ error: "Add ?confirm=yes to wipe all standing knowledge" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }
    try {
      await knowStore.delete("knowledge");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e?.message || String(e) }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }
  }

  if (req.method === "PUT") {
    // Admin override: replace the entire knowledge corpus with provided JSON
    try {
      const body = await req.json() as Knowledge;
      // Minimal shape validation
      if (!body || typeof body !== "object" || !Array.isArray(body.people)) {
        return new Response(JSON.stringify({ error: "Body must include people, projects, preferences, decisions arrays" }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
      const normalized: Knowledge = {
        people: Array.isArray(body.people) ? body.people : [],
        projects: Array.isArray(body.projects) ? body.projects : [],
        preferences: Array.isArray(body.preferences) ? body.preferences : [],
        decisions: Array.isArray(body.decisions) ? body.decisions : [],
        lastExtractedFromAt: body.lastExtractedFromAt,
        totalExtractions: body.totalExtractions || 0,
      };
      await knowStore.setJSON("knowledge", normalized);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e?.message || String(e) }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405, headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: ["/api/memory", "/api/memory/extract"],
};
