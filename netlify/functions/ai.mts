import type { Context, Config } from "@netlify/functions";

const SYSTEM_PROMPT = `You are SAM (Secret Agent Man), Dr. David Hatami's AI Chief of Staff. You are a research and analysis assistant with expertise in AI ethics, higher education, policy development, and business strategy. Be direct, thorough, and actionable. When asked to compare or research across AI platforms, provide honest, evidence-based analysis. No fluff.`;

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
          model: "claude-sonnet-4-20250514",
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
          model: "gpt-4o",
          messages,
          max_tokens: 4096,
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

    // ── GEMINI (Google) — future slot ──
    if (model === "gemini") {
      const GEMINI_KEY = Netlify.env.get("GEMINI_API_KEY");
      if (!GEMINI_KEY) {
        return new Response(
          JSON.stringify({ error: "Gemini slot is open. Add GEMINI_API_KEY to Netlify env vars to activate." }),
          { status: 501, headers: { "Content-Type": "application/json" } }
        );
      }
      // TODO: wire Gemini API when key provided
      return new Response(
        JSON.stringify({ error: "Gemini integration pending key." }),
        { status: 501, headers: { "Content-Type": "application/json" } }
      );
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
