/**
 * SAM LLM COST TRACKING — Phase 8
 *
 * Every paid API call records a row in model_costs. Each row has the model,
 * feature (e.g. "chat", "memory_extract", "triage"), token counts, and an
 * estimated dollar cost. Daily/weekly aggregations come from SQL.
 *
 * Pricing constants below are placeholders. Replace with verified rates
 * from Anthropic/OpenAI/Google billing dashboards. Until then, cost_cents
 * defaults to 0 and the dashboard shows token counts only.
 *
 * Why a helper instead of inline tracking: callsites are scattered across
 * ai.mts, memory-extract.ts, triage-core.ts, anticipations-lib.ts,
 * review-core.ts, transcripts-core.ts, briefing.mts. A helper means one
 * change updates pricing for every callsite. Adding a new callsite means
 * one import line.
 */

import { recordModelCost } from "./sam-db.ts";

// ─────────────────────────────────────────────────────────────────────────
// PRICING — fill in with verified rates from each provider's billing page.
// Cents per 1M tokens. Set to 0 to skip cost calculation; tokens are still
// recorded so we have raw usage data even before pricing is confirmed.
// ─────────────────────────────────────────────────────────────────────────

interface ModelPricing {
  inputCentsPer1M: number;
  outputCentsPer1M: number;
  cachedInputCentsPer1M?: number;
}

const PRICING: Record<string, ModelPricing> = {
  // Anthropic — TODO confirm exact rates from console.anthropic.com/billing
  // Setting all to 0 until verified to avoid fabricated cost numbers.
  "claude-opus-4-7": { inputCentsPer1M: 0, outputCentsPer1M: 0 },
  "claude-opus-4-6": { inputCentsPer1M: 0, outputCentsPer1M: 0 },
  "claude-sonnet-4-6": { inputCentsPer1M: 0, outputCentsPer1M: 0 },
  "claude-haiku-4-5-20251001": { inputCentsPer1M: 0, outputCentsPer1M: 0 },
  // OpenAI — TODO confirm from platform.openai.com/account/billing
  "gpt-5.4": { inputCentsPer1M: 0, outputCentsPer1M: 0 },
  // Google — TODO confirm from Google AI Studio billing
  "gemini-2.5-flash": { inputCentsPer1M: 0, outputCentsPer1M: 0 },
};

function estimateCostCents(model: string, inputTokens: number, outputTokens: number, cachedInputTokens: number = 0): number {
  const p = PRICING[model];
  if (!p) return 0;
  const billableInput = Math.max(0, inputTokens - cachedInputTokens);
  const inCents = (billableInput / 1_000_000) * p.inputCentsPer1M;
  const outCents = (outputTokens / 1_000_000) * p.outputCentsPer1M;
  const cachedCents = (cachedInputTokens / 1_000_000) * (p.cachedInputCentsPer1M ?? p.inputCentsPer1M * 0.1);
  return inCents + outCents + cachedCents;
}

// ─────────────────────────────────────────────────────────────────────────
// PROVIDER-SPECIFIC PARSERS — extract token usage from response shapes
// ─────────────────────────────────────────────────────────────────────────

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export function parseAnthropicUsage(responseBody: any): TokenUsage {
  const u = responseBody?.usage || {};
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cachedInputTokens: (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
  };
}

export function parseOpenAIUsage(responseBody: any): TokenUsage {
  const u = responseBody?.usage || {};
  return {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    cachedInputTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

export function parseGeminiUsage(responseBody: any): TokenUsage {
  const u = responseBody?.usageMetadata || {};
  return {
    inputTokens: u.promptTokenCount ?? 0,
    outputTokens: u.candidatesTokenCount ?? 0,
    cachedInputTokens: u.cachedContentTokenCount ?? 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// PUBLIC: record a tracked call. Call this AFTER you have the response.
// ─────────────────────────────────────────────────────────────────────────

export async function trackCost(input: {
  provider: "anthropic" | "openai" | "gemini";
  model: string;
  feature: string;
  responseBody: any;
  metadata?: Record<string, any>;
}): Promise<void> {
  const usage =
    input.provider === "anthropic"
      ? parseAnthropicUsage(input.responseBody)
      : input.provider === "openai"
      ? parseOpenAIUsage(input.responseBody)
      : parseGeminiUsage(input.responseBody);

  const costCents = estimateCostCents(input.model, usage.inputTokens, usage.outputTokens, usage.cachedInputTokens);
  await recordModelCost({
    model: input.model,
    feature: input.feature,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    costCents,
    metadata: input.metadata,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Convenience wrapper for the common case: do an Anthropic Messages call
// AND record the cost in one go. Returns the parsed JSON response.
// Use this when you don't need streaming or custom error handling.
// ─────────────────────────────────────────────────────────────────────────

export async function trackedAnthropicCall(input: {
  apiKey: string;
  model: string;
  feature: string;
  body: any; // already-shaped Anthropic Messages request body
  metadata?: Record<string, any>;
}): Promise<any> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": input.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...input.body, model: input.model }),
  });
  const data = await r.json();
  if (!r.ok) {
    // Log a failed-call record so we know the request was attempted
    await recordModelCost({
      model: input.model,
      feature: input.feature,
      inputTokens: 0,
      outputTokens: 0,
      costCents: 0,
      metadata: { ...input.metadata, error: data?.error?.message || `HTTP ${r.status}` },
    });
    throw new Error(`Anthropic ${r.status}: ${data?.error?.message || "unknown"}`);
  }
  await trackCost({
    provider: "anthropic",
    model: input.model,
    feature: input.feature,
    responseBody: data,
    metadata: input.metadata,
  });
  return data;
}
