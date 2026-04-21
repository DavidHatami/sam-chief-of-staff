import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const BASE_PROMPT = `You are SAM (Secret Agent Man), Dr. David Hatami's AI Chief of Staff. You are a research and analysis assistant with expertise in AI ethics, higher education, policy development, and business strategy. Be direct, thorough, and actionable. When asked to compare or research across AI platforms, provide honest, evidence-based analysis. No fluff.`;

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
      if (history && Array.isArray(history)) {
        history.forEach((h: { role: string; content: string }) => {
          messages.push({ role: h.role, content: h.content });
        });
      }
      messages.push({ role: "user", content: prompt });

      const resp = await fetch("https://api.anthropic.com/v1/messages", {
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
      });

      const data = await resp.json();
      const reply =
        data.content
          ?.map((b: { type: string; text?: string }) =>
            b.type === "text" ? b.text : ""
          )
          .join("") || data.error?.message || "No response from Claude.";

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
      if (history && Array.isArray(history)) {
        history.forEach((h: { role: string; content: string }) => {
          messages.push({ role: h.role, content: h.content });
        });
      }
      messages.push({ role: "user", content: prompt });

      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
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
      });

      const data = await resp.json();
      const reply =
        data.choices?.[0]?.message?.content ||
        data.error?.message ||
        "No response from OpenAI.";

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
      if (history && Array.isArray(history)) {
        history.forEach((h: { role: string; content: string }) => {
          contents.push({
            role: h.role === "assistant" ? "model" : "user",
            parts: [{ text: h.content }],
          });
        });
      }
      contents.push({ role: "user", parts: [{ text: prompt }] });

      const resp = await fetch(
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
        }
      );

      const data = await resp.json();
      const reply =
        data.candidates?.[0]?.content?.parts
          ?.map((p: { text?: string }) => p.text || "")
          .join("") ||
        data.error?.message ||
        "No response from Gemini.";

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

      // Fire all available models simultaneously
      const calls: Array<{ name: string; promise: Promise<Response> }> = [];

      // Claude
      calls.push({
        name: "Claude Opus 4.6",
        promise: fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-opus-4-6", max_tokens: 1024, system: SYSTEM_PROMPT, messages: [{ role: "user", content: prompt }] }),
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
          }),
        });
      }

      // Wait for all to complete
      const results = await Promise.allSettled(calls.map(c => c.promise));
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
        const synthResp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({
            model: "claude-opus-4-6",
            max_tokens: 2048,
            system: "You are SAM's Council Synthesizer. Combine multiple AI perspectives into one superior answer. Be direct and concise. Credit models by name when they contribute unique insights. End with a brief [Council Notes] line.",
            messages: [{ role: "user", content: synthesisPrompt }],
          }),
        });

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
