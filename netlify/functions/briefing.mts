import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { buildAndSendBriefing } from "../lib/briefing-core.ts";

/**
 * SAM PHASE 1.1 — BRIEFING HTTP ENDPOINTS
 *
 * Three endpoints so the dashboard (and David) can interact with the
 * briefing engine without waiting for the 6 AM cron:
 *
 *   POST /api/briefing/now         → fire a briefing right now
 *   GET  /api/briefing/history     → last 30 briefing dates
 *   GET  /api/briefing/get?date=   → read one archived briefing
 */

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/api/briefing/now" && req.method === "POST") {
    try {
      const result = await buildAndSendBriefing();
      return json(result, 200);
    } catch (e: any) {
      console.error("Manual briefing failed:", e);
      return json({ error: e.message, stack: e.stack }, 500);
    }
  }

  if (path === "/api/briefing/history" && req.method === "GET") {
    try {
      const store = getStore({ name: "sam-briefings", consistency: "strong" });
      const { blobs } = await store.list();
      const dates = blobs
        .map((b: any) => b.key)
        .sort()
        .reverse()
        .slice(0, 30);
      return json({ dates, count: blobs.length }, 200, true);
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  if (path === "/api/briefing/get" && req.method === "GET") {
    const date = url.searchParams.get("date");
    if (!date) return json({ error: "Missing date param (YYYY-MM-DD)" }, 400);
    try {
      const store = getStore({ name: "sam-briefings", consistency: "strong" });
      const data = await store.get(date, { type: "json" });
      if (!data) return json({ error: "Not found" }, 404);
      return json(data, 200, true, 600);  // 10-min cache — archived briefings never change
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  if (path === "/api/briefing/tts" && req.method === "GET") {
    const date = url.searchParams.get("date");
    if (!date) return json({ error: "Missing date param (YYYY-MM-DD)" }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Bad date format" }, 400);
    try {
      const audioStore = getStore({ name: "sam-briefing-audio", consistency: "strong" });

      // Cache hit — return MP3 immediately
      const cached = await audioStore.get(date, { type: "arrayBuffer" }).catch(() => null);
      if (cached) {
        return new Response(cached, {
          status: 200,
          headers: {
            "Content-Type": "audio/mpeg",
            "Content-Length": String(cached.byteLength),
            "X-Cache": "hit",
            "Cache-Control": "private, max-age=86400",
          },
        });
      }

      // Cache miss — fetch the briefing text
      const briefStore = getStore({ name: "sam-briefings", consistency: "strong" });
      const data: any = await briefStore.get(date, { type: "json" });
      if (!data || !data.briefing) return json({ error: "No briefing for that date" }, 404);

      // Strip markdown so TTS doesn't speak "hash hash hash" or "asterisk asterisk"
      const speech = stripMarkdownForSpeech(data.briefing);
      // OpenAI tts-1 input cap is 4096 chars — truncate cleanly at sentence boundary
      const speechClipped = speech.length > 4000
        ? speech.slice(0, 4000).replace(/[^.!?]*$/, '').trim() || speech.slice(0, 4000)
        : speech;

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return json({ error: "OPENAI_API_KEY not set" }, 500);

      const ttsResp = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "tts-1",
          voice: "nova", // warm, calm, female — good for a briefing read
          input: speechClipped,
          response_format: "mp3",
          speed: 1.0,
        }),
      });

      if (!ttsResp.ok) {
        const errBody = await ttsResp.text();
        return json({
          error: `OpenAI TTS failed: HTTP ${ttsResp.status}`,
          detail: errBody.substring(0, 300),
        }, 502);
      }

      const audioBytes = await ttsResp.arrayBuffer();

      // Cache for next time — best-effort, don't fail the request if the write fails
      try {
        await audioStore.set(date, audioBytes);
      } catch (cacheErr) {
        console.error(`[briefing/tts] cache write failed for ${date}:`, cacheErr);
      }

      return new Response(audioBytes, {
        status: 200,
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Length": String(audioBytes.byteLength),
          "X-Cache": "miss",
          "Cache-Control": "private, max-age=86400",
        },
      });
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  return json({ error: "Not found", path }, 404);
};

function json(body: any, status: number, cacheable = false, maxAge = 30) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cacheable && status === 200) {
    headers["Cache-Control"] = `private, max-age=${maxAge}, stale-while-revalidate=${maxAge * 4}`;
  }
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Convert briefing markdown to clean spoken-form text.
 * Removes hashes, asterisks, dash bullets, link syntax, code fences.
 * Inserts pauses (periods) where the markdown structure implied a break.
 */
function stripMarkdownForSpeech(md: string): string {
  let s = String(md || "");
  // Remove fenced code blocks entirely — they don't read aloud well
  s = s.replace(/```[\s\S]*?```/g, "");
  // Inline code -> just the content
  s = s.replace(/`([^`]+)`/g, "$1");
  // Headers: keep text, drop hashes; ensure they end with a period for pause
  s = s.replace(/^#{1,6}\s+(.+)$/gm, (_m, h) => {
    const t = h.trim();
    return /[.!?:]$/.test(t) ? t : t + ".";
  });
  // Bold / italic markers -> drop the punctuation, keep the words
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/\*([^*]+)\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/_([^_]+)_/g, "$1");
  // Bullet markers at line start
  s = s.replace(/^\s*[-*+]\s+/gm, "");
  // Numbered list markers
  s = s.replace(/^\s*\d+\.\s+/gm, "");
  // Markdown links [text](url) -> text
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Standalone URLs read terribly aloud — drop them entirely
  s = s.replace(/https?:\/\/\S+/g, "");
  // Horizontal rules
  s = s.replace(/^-{3,}$/gm, "");
  // Collapse 3+ newlines to 2
  s = s.replace(/\n{3,}/g, "\n\n");
  // Trim
  return s.trim();
}

export const config: Config = {
  path: ["/api/briefing/now", "/api/briefing/history", "/api/briefing/get", "/api/briefing/tts"],
};
