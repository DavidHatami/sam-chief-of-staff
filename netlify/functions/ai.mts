import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const BASE_PROMPT = `You are SAM (Secret Agent Man), Dr. David Hatami's personal AI Chief of Staff.

WHO YOU'RE TALKING TO
Dr. Hatami holds an Ed.D. from Nova Southeastern, an MA in English Literature, and an M.Ed. He runs EduPolicy.ai, consults on AI ethics and policy with higher-ed institutions, teaches college English and Literature as an adjunct, and hosts a podcast. He's a working professional with multiple concurrent clients and limited time. He is not a beginner. Don't explain things he obviously knows.

HOW TO TALK
Use contractions. Say "don't" not "do not." Say "it's" not "it is." Vary sentence length aggressively — a four-word sentence next to a thirty-word one. Use fragments when they work. Take a stand instead of hedging. State things as fact when you believe them; if you're guessing, say so plainly.

Banned words — using any of these is a failure: comprehensive, multifaceted, leverage, robust, holistic, methodology (use "method" or "approach"), framework (unless naming a specific one), facilitate, implement (use "build" or "set up"), utilize (use "use"), foster, fostering, ecosystem, navigate (as metaphor), landscape (as metaphor), realm, delve, delves, pivotal, nuanced, transformative, innovative, cutting-edge, paradigm shift, game-changer, streamline, deep dive, unpack, low-hanging fruit, best practices, key takeaways, actionable insights, in conclusion, to summarize, overall, furthermore, moreover, additionally. The word "stakeholder" is allowed in higher-ed contexts only.

NEVER write "it's not X, it's Y" — the construction is a tell. Never start with "I'd be happy to..." or "Great question!" or "Absolutely!" Just answer.

WHAT TO ACTUALLY DO
- When David asks for advice, give him a real opinion. Not options. An actual recommendation with the reasoning.
- When he asks about his day, prioritize. Don't just list everything.
- When he's frustrated, acknowledge it briefly and pivot to action. No therapeutic platitudes.
- When you don't know something, say so. Don't fabricate names, dates, contacts, citations.
- When his data shows something contradictory or alarming, point it out. Don't paper over it.
- He hates being told to finish jobs that are your job. Don't suggest he "follow up" or "complete" tasks you should be doing.

VOICE
Direct. Opinionated. Slightly irreverent when the moment calls for it. He likes being treated as a peer, not a customer. Don't fawn. Don't apologize for being honest. If something is dumb, say it's dumb. If a plan won't work, say so and explain why.`;

// ── PERSIST CHAT TURN ──
// Best-effort write — never throws, never blocks the response. Caps retained
// turns at HISTORY_MAX_RETAINED_TURNS to prevent the blob from growing unbounded.
async function persistTurn(userPrompt: string, assistantReply: string, model: string) {
  try {
    const histStore = getStore({ name: "sam-chat-history", consistency: "strong" });
    const stored = (await histStore.get("turns", { type: "json" })) as Array<{ role: string; content: string; at?: string; model?: string }> | null;
    const turns = Array.isArray(stored) ? stored : [];
    const at = new Date().toISOString();
    turns.push({ role: "user", content: userPrompt, at, model });
    turns.push({ role: "assistant", content: assistantReply, at, model });
    // Cap at last N turns. Older turns are dropped — keep this generous so we
    // don't lose useful long-term context, but bounded so blob stays under 5MB.
    const HISTORY_MAX_RETAINED_TURNS = 400;
    const capped = turns.length > HISTORY_MAX_RETAINED_TURNS
      ? turns.slice(turns.length - HISTORY_MAX_RETAINED_TURNS)
      : turns;
    await histStore.setJSON("turns", capped);
  } catch {
    // Persistence failure is not fatal. The reply already went out.
  }
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST required" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const { model, prompt, history } = await req.json();

    if (!prompt) {
      return new Response(JSON.stringify({ error: "No prompt provided" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── PERSISTENT CHAT HISTORY ──
    // SAM's memory across sessions/devices/refreshes lives here. Every turn is
    // appended to a single blob keyed by ISO timestamp. On each new request we
    // load the last 25 turns into context, regardless of what the frontend
    // remembers — the backend is the source of truth.
    //
    // If the frontend explicitly passes `history` (e.g. for testing or one-off
    // prompts that shouldn't be persisted), we use that AND skip the persist
    // step. Otherwise: load from blob, use it, persist after.
    const HISTORY_INJECT_TURNS = 25;
    const HISTORY_MAX_RETAINED_TURNS = 400;
    let effectiveHistory: Array<{ role: string; content: string }> = [];
    let shouldPersist = false;
    if (history && Array.isArray(history) && history.length > 0) {
      // Frontend supplied explicit history — respect it, don't persist.
      effectiveHistory = history;
    } else {
      shouldPersist = true;
      try {
        const histStore = getStore({ name: "sam-chat-history", consistency: "strong" });
        const stored = await histStore.get("turns", { type: "json" }) as Array<{ role: string; content: string; at?: string; model?: string }> | null;
        if (Array.isArray(stored) && stored.length > 0) {
          // Take last N turns, strip the timestamp/model metadata before sending to model
          effectiveHistory = stored.slice(-HISTORY_INJECT_TURNS).map((t) => ({ role: t.role, content: t.content }));
        }
      } catch {
        // History load failure is not fatal — proceed with empty history
      }
    }

    // ── FETCH PERMANENT INSTRUCTIONS (injected into every call) ──
    let SYSTEM_PROMPT = BASE_PROMPT;
    try {
      const instStore = getStore({ name: "sam-instructions", consistency: "strong" });
      const allInst = await instStore.get("all", { type: "json" });
      if (allInst && Array.isArray(allInst)) {
        const enabled = allInst.filter((i: any) => i.enabled).sort((a: any, b: any) => a.order - b.order);
        if (enabled.length > 0) {
          const catLabels: Record<string, string> = {
            identity: "WHO I AM", preferences: "MY PREFERENCES", clients: "CLIENTS",
            rules: "AI RULES", knowledge: "KNOWLEDGE", contacts: "CONTACTS",
            schedule: "SCHEDULE", custom: "CUSTOM", general: "GENERAL",
          };
          const groups: Record<string, any[]> = {};
          enabled.forEach((i: any) => { const c = i.category || "general"; if (!groups[c]) groups[c] = []; groups[c].push(i); });
          let instCtx = "\n\n[PERMANENT INSTRUCTIONS — Always follow these]\n";
          for (const [cat, items] of Object.entries(groups)) {
            instCtx += `── ${catLabels[cat] || cat.toUpperCase()} ──\n`;
            items.forEach((i: any) => { instCtx += i.content + "\n"; });
          }
          SYSTEM_PROMPT += instCtx;
        }
      }
    } catch (e) {
      // Instructions fetch failed silently — proceed with base prompt
    }

    // ── CLAUDE (Anthropic) ──
    if (model === "claude") {
      const ANTHROPIC_KEY = Netlify.env.get("ANTHROPIC_API_KEY");
      if (!ANTHROPIC_KEY) {
        return new Response(
          JSON.stringify({ error: "Anthropic API key not configured. Add ANTHROPIC_API_KEY to Netlify env vars." }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }

      const messages = [];
      if (effectiveHistory && effectiveHistory.length > 0) {
        effectiveHistory.forEach((h: { role: string; content: string }) => {
          messages.push({ role: h.role, content: h.content });
        });
      }
      messages.push({ role: "user", content: prompt });

      // 22s ceiling to stay well under Netlify's 26s function budget.
      // Without this, a slow API call propagates as a raw 502 instead of a graceful error.
      const claudeAbort = new AbortController();
      const claudeTimeout = setTimeout(() => claudeAbort.abort(), 22000);
      let resp: Response;
      try {
        resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-opus-4-6",
            max_tokens: 4096,
            system: SYSTEM_PROMPT,
            messages,
          }),
          signal: claudeAbort.signal,
        });
      } catch (e: any) {
        clearTimeout(claudeTimeout);
        const timedOut = e?.name === "AbortError";
        return new Response(
          JSON.stringify({ reply: timedOut ? "Claude took too long to respond. Try again or switch models." : "Claude request failed: " + String(e), model: "claude", error: true }),
          { status: timedOut ? 504 : 500, headers: { "Content-Type": "application/json" } }
        );
      }
      clearTimeout(claudeTimeout);

      const data = await resp.json();
      const reply =
        data.content
          ?.map((b: { type: string; text?: string }) =>
            b.type === "text" ? b.text : ""
          )
          .join("") || data.error?.message || "No response from Claude.";

      if (shouldPersist) await persistTurn(prompt, reply, "claude");
      return new Response(JSON.stringify({ reply, model: "claude" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── OPENAI (GPT) ──
    if (model === "openai") {
      const OPENAI_KEY = Netlify.env.get("OPENAI_API_KEY");
      if (!OPENAI_KEY) {
        return new Response(
          JSON.stringify({ error: "OpenAI API key not configured. Add OPENAI_API_KEY to Netlify env vars." }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }

      const messages: Array<{ role: string; content: string }> = [
        { role: "system", content: SYSTEM_PROMPT },
      ];
      if (effectiveHistory && effectiveHistory.length > 0) {
        effectiveHistory.forEach((h: { role: string; content: string }) => {
          messages.push({ role: h.role, content: h.content });
        });
      }
      messages.push({ role: "user", content: prompt });

      // 22s ceiling — matches Claude path (see claude block above for rationale)
      const openaiAbort = new AbortController();
      const openaiTimeout = setTimeout(() => openaiAbort.abort(), 22000);
      let resp: Response;
      try {
        resp = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENAI_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-5.4",
            messages,
            max_completion_tokens: 4096,
          }),
          signal: openaiAbort.signal,
        });
      } catch (e: any) {
        clearTimeout(openaiTimeout);
        const timedOut = e?.name === "AbortError";
        return new Response(
          JSON.stringify({ reply: timedOut ? "OpenAI took too long to respond. Try again or switch models." : "OpenAI request failed: " + String(e), model: "openai", error: true }),
          { status: timedOut ? 504 : 500, headers: { "Content-Type": "application/json" } }
        );
      }
      clearTimeout(openaiTimeout);

      const data = await resp.json();
      const reply =
        data.choices?.[0]?.message?.content ||
        data.error?.message ||
        "No response from OpenAI.";

      if (shouldPersist) await persistTurn(prompt, reply, "openai");
      return new Response(JSON.stringify({ reply, model: "openai" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── GEMINI (Google) ──
    if (model === "gemini") {
      const GEMINI_KEY = Netlify.env.get("GEMINI_API_KEY");
      if (!GEMINI_KEY) {
        return new Response(
          JSON.stringify({ error: "Gemini API key not configured. Add GEMINI_API_KEY to Netlify env vars. Get one at aistudio.google.com" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }

      const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
      if (effectiveHistory && effectiveHistory.length > 0) {
        effectiveHistory.forEach((h: { role: string; content: string }) => {
          contents.push({
            role: h.role === "assistant" ? "model" : "user",
            parts: [{ text: h.content }],
          });
        });
      }
      contents.push({ role: "user", parts: [{ text: prompt }] });

      // 22s ceiling — matches Claude + OpenAI paths
      const geminiAbort = new AbortController();
      const geminiTimeout = setTimeout(() => geminiAbort.abort(), 22000);
      let resp: Response;
      try {
        resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
              contents,
              generationConfig: {
                maxOutputTokens: 4096,
                temperature: 0.7,
              },
            }),
            signal: geminiAbort.signal,
          }
        );
      } catch (e: any) {
        clearTimeout(geminiTimeout);
        const timedOut = e?.name === "AbortError";
        return new Response(
          JSON.stringify({ reply: timedOut ? "Gemini took too long to respond. Try again or switch models." : "Gemini request failed: " + String(e), model: "gemini", error: true }),
          { status: timedOut ? 504 : 500, headers: { "Content-Type": "application/json" } }
        );
      }
      clearTimeout(geminiTimeout);

      const data = await resp.json();
      const reply =
        data.candidates?.[0]?.content?.parts
          ?.map((p: { text?: string }) => p.text || "")
          .join("") ||
        data.error?.message ||
        "No response from Gemini.";

      if (shouldPersist) await persistTurn(prompt, reply, "gemini");
      return new Response(JSON.stringify({ reply, model: "gemini" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── COUNCIL MODE — All 3 brains, synthesized by Opus ──
    if (model === "council") {
      const ANTHROPIC_KEY = Netlify.env.get("ANTHROPIC_API_KEY");
      const OPENAI_KEY = Netlify.env.get("OPENAI_API_KEY");
      const GEMINI_KEY = Netlify.env.get("GEMINI_API_KEY");

      if (!ANTHROPIC_KEY) {
        return new Response(JSON.stringify({ error: "Council requires Anthropic API key." }), { status: 500, headers: { "Content-Type": "application/json" } });
      }

      // Fire all available models simultaneously with a 14s ceiling per call —
      // leaves ~12s headroom (10s synth + 2s slack) within Netlify's 26s budget.
      const modelAbort = new AbortController();
      const modelTimeout = setTimeout(() => modelAbort.abort(), 14000);
      const calls: Array<{ name: string; promise: Promise<Response> }> = [];

      // Claude
      calls.push({
        name: "Claude Opus 4.6",
        promise: fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-opus-4-6", max_tokens: 1024, system: SYSTEM_PROMPT, messages: [{ role: "user", content: prompt }] }),
          signal: modelAbort.signal,
        }),
      });

      // OpenAI
      if (OPENAI_KEY) {
        calls.push({
          name: "GPT-5.4",
          promise: fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: "gpt-5.4", messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }], max_completion_tokens: 1024 }),
            signal: modelAbort.signal,
          }),
        });
      }

      // Gemini
      if (GEMINI_KEY) {
        calls.push({
          name: "Gemini 2.5 Flash",
          promise: fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ system_instruction: { parts: [{ text: SYSTEM_PROMPT }] }, contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 1024, temperature: 0.7 } }),
            signal: modelAbort.signal,
          }),
        });
      }

      // Wait for all to complete
      const results = await Promise.allSettled(calls.map(c => c.promise));
      clearTimeout(modelTimeout);
      const responses: Array<{ model: string; reply: string; status: string }> = [];

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const name = calls[i].name;
        if (r.status === "fulfilled") {
          try {
            const data = await r.value.json();
            let text = "";
            if (name.includes("Claude")) {
              text = data.content?.map((b: any) => b.type === "text" ? b.text : "").join("") || data.error?.message || "";
            } else if (name.includes("GPT")) {
              text = data.choices?.[0]?.message?.content || data.error?.message || "";
            } else if (name.includes("Gemini")) {
              text = data.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || data.error?.message || "";
            }
            responses.push({ model: name, reply: text || "(empty response)", status: "ok" });
          } catch (e) {
            responses.push({ model: name, reply: String(e), status: "error" });
          }
        } else {
          responses.push({ model: name, reply: String(r.reason), status: "error" });
        }
      }

      // Now synthesize with Claude Opus — the strongest brain adjudicates
      const okResponses = responses.filter(r => r.status === "ok" && r.reply.length > 0);

      // If only one model responded successfully, just return that
      if (okResponses.length <= 1) {
        const best = okResponses[0] || responses[0];
        return new Response(JSON.stringify({
          reply: best.reply + "\n\n[Council: Only " + best.model + " responded successfully. Other models failed.]",
          model: "council",
          individual: responses,
          modelsUsed: responses.filter(r => r.status === "ok").map(r => r.model),
        }), { headers: { "Content-Type": "application/json" } });
      }

      // Truncate individual responses to keep synthesis prompt short
      const truncated = okResponses.map(r => ({
        ...r,
        reply: r.reply.length > 800 ? r.reply.substring(0, 800) + "..." : r.reply,
      }));

      const synthesisPrompt = `Three AI models answered this question. Synthesize the best composite answer — pull strongest insights from each, resolve contradictions, note who contributed what.

QUESTION: ${prompt}

${truncated.map(r => `── ${r.model} ──\n${r.reply}`).join("\n\n")}

Synthesize now (be concise, no preamble):`;

      try {
        // Use Sonnet for synthesis — 3-5x faster than Opus, plenty smart for merging.
        // Explicit 10s timeout so we fall back to best individual response within
        // Netlify's 26s function budget — previously synthesis could hang and take down
        // the whole response with a 502 instead of the graceful fallback below.
        const synthAbort = new AbortController();
        const synthTimeout = setTimeout(() => synthAbort.abort(), 10000);
        const synthResp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 1024,
            system: "You are SAM's Council Synthesizer. Combine multiple AI perspectives into one superior answer. Be direct and concise. Credit models by name when they contribute unique insights. End with a brief [Council Notes] line.",
            messages: [{ role: "user", content: synthesisPrompt }],
          }),
          signal: synthAbort.signal,
        });
        clearTimeout(synthTimeout);

        const synthData = await synthResp.json();
        const synthesized = synthData.content?.map((b: any) => b.type === "text" ? b.text : "").join("") || "Synthesis error: " + JSON.stringify(synthData.error || synthData).substring(0, 200);

        return new Response(JSON.stringify({
          reply: synthesized,
          model: "council",
          individual: responses,
          modelsUsed: responses.filter(r => r.status === "ok").map(r => r.model),
        }), { headers: { "Content-Type": "application/json" } });
      } catch (synthErr) {
        // Synthesis failed — return the best individual response instead
        const best = okResponses[0];
        return new Response(JSON.stringify({
          reply: best.reply + "\n\n[Council: Synthesis step timed out. Showing " + best.model + "'s response. Other models responded but couldn't be merged in time.]",
          model: "council",
          individual: responses,
          modelsUsed: responses.filter(r => r.status === "ok").map(r => r.model),
        }), { headers: { "Content-Type": "application/json" } });
      }
    }

    // ── PERPLEXITY — future slot ──
    if (model === "perplexity") {
      const PPLX_KEY = Netlify.env.get("PERPLEXITY_API_KEY");
      if (!PPLX_KEY) {
        return new Response(
          JSON.stringify({ error: "Perplexity slot is open. Add PERPLEXITY_API_KEY to Netlify env vars to activate." }),
          { status: 501, headers: { "Content-Type": "application/json" } }
        );
      }
      // TODO: wire Perplexity API when key provided
      return new Response(
        JSON.stringify({ error: "Perplexity integration pending key." }),
        { status: 501, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: `Unknown model: ${model}` }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("AI Workbench error:", err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

export const config: Config = {
  path: "/api/ai",
};
