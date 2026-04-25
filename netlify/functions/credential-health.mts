import type { Context, Config } from "@netlify/functions";

/**
 * SAM CREDENTIAL HEALTH — pings every external service we depend on
 *
 *   GET /api/credentials/health → status of every credential
 *
 * Each credential gets pinged in parallel with a 5s timeout. We verify the
 * key works, NOT that the service is healthy — a passing check means
 * "if the cron fires now, the credential won't be the failure point."
 *
 * Where expiration dates are knowable (M365 client secret, GitHub fine-grained
 * PAT) we include `daysUntilExpiry`. Where the credential is rotated manually
 * (Yahoo, Resend, Anthropic), we include `lastVerified`.
 */

interface CredCheck {
  service: string;
  label: string;
  status: "ok" | "warning" | "alarm" | "unknown";
  checkLatencyMs: number;
  reason: string;
  daysUntilExpiry?: number | null;
  expiresAt?: string | null;
  notes?: string;
}

async function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    fn().then((v) => { clearTimeout(id); resolve(v); }).catch((e) => { clearTimeout(id); reject(e); });
  });
}

// ── Per-service probes ──

async function checkAnthropic(): Promise<CredCheck> {
  const t = Date.now();
  const key = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!key) return { service: "anthropic", label: "Claude AI", status: "alarm", checkLatencyMs: 0, reason: "ANTHROPIC_API_KEY missing" };
  try {
    // Cheapest valid call: 1-token completion against the smallest model
    const r = await withTimeout(() => fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    }), 5000, "Anthropic");
    const elapsed = Date.now() - t;
    if (r.status === 401 || r.status === 403) {
      return { service: "anthropic", label: "Claude AI", status: "alarm", checkLatencyMs: elapsed, reason: `Auth rejected (HTTP ${r.status}) — key invalid or revoked` };
    }
    if (r.status === 429) {
      return { service: "anthropic", label: "Claude AI", status: "warning", checkLatencyMs: elapsed, reason: "Rate-limited (HTTP 429) — credit may be exhausted" };
    }
    if (!r.ok) {
      return { service: "anthropic", label: "Claude AI", status: "warning", checkLatencyMs: elapsed, reason: `Unexpected HTTP ${r.status}` };
    }
    return { service: "anthropic", label: "Claude AI", status: "ok", checkLatencyMs: elapsed, reason: "Key valid + accepting requests" };
  } catch (e: any) {
    return { service: "anthropic", label: "Claude AI", status: "warning", checkLatencyMs: Date.now() - t, reason: e?.message || String(e) };
  }
}

async function checkOpenAI(): Promise<CredCheck> {
  const t = Date.now();
  const key = Netlify.env.get("OPENAI_API_KEY");
  if (!key) return { service: "openai", label: "OpenAI (TTS)", status: "alarm", checkLatencyMs: 0, reason: "OPENAI_API_KEY missing" };
  try {
    const r = await withTimeout(() => fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    }), 5000, "OpenAI");
    const elapsed = Date.now() - t;
    if (r.status === 401) return { service: "openai", label: "OpenAI (TTS)", status: "alarm", checkLatencyMs: elapsed, reason: "Auth rejected — key invalid" };
    if (r.status === 429) return { service: "openai", label: "OpenAI (TTS)", status: "warning", checkLatencyMs: elapsed, reason: "Rate-limited" };
    if (!r.ok) return { service: "openai", label: "OpenAI (TTS)", status: "warning", checkLatencyMs: elapsed, reason: `HTTP ${r.status}` };
    return { service: "openai", label: "OpenAI (TTS)", status: "ok", checkLatencyMs: elapsed, reason: "Key valid" };
  } catch (e: any) {
    return { service: "openai", label: "OpenAI (TTS)", status: "warning", checkLatencyMs: Date.now() - t, reason: e?.message || String(e) };
  }
}

async function checkGemini(): Promise<CredCheck> {
  const t = Date.now();
  const key = Netlify.env.get("GEMINI_API_KEY");
  if (!key) return { service: "gemini", label: "Gemini", status: "alarm", checkLatencyMs: 0, reason: "GEMINI_API_KEY missing" };
  try {
    const r = await withTimeout(() => fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`), 5000, "Gemini");
    const elapsed = Date.now() - t;
    if (r.status === 400 || r.status === 403) return { service: "gemini", label: "Gemini", status: "alarm", checkLatencyMs: elapsed, reason: `Auth rejected (HTTP ${r.status})` };
    if (!r.ok) return { service: "gemini", label: "Gemini", status: "warning", checkLatencyMs: elapsed, reason: `HTTP ${r.status}` };
    return { service: "gemini", label: "Gemini", status: "ok", checkLatencyMs: elapsed, reason: "Key valid" };
  } catch (e: any) {
    return { service: "gemini", label: "Gemini", status: "warning", checkLatencyMs: Date.now() - t, reason: e?.message || String(e) };
  }
}

async function checkM365(): Promise<CredCheck> {
  const t = Date.now();
  const tenant = Netlify.env.get("M365_TENANT_ID");
  const clientId = Netlify.env.get("M365_CLIENT_ID");
  const secret = Netlify.env.get("M365_CLIENT_SECRET");
  if (!tenant || !clientId || !secret) return { service: "m365", label: "Microsoft 365", status: "alarm", checkLatencyMs: 0, reason: "M365 credentials missing" };
  try {
    const tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: secret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });
    const r = await withTimeout(() => fetch(tokenUrl, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
    }), 5000, "M365 token");
    const elapsed = Date.now() - t;
    if (!r.ok) {
      const errText = (await r.text()).substring(0, 200);
      const isExpiredSecret = errText.includes("AADSTS7000222") || errText.includes("AADSTS7000215") || errText.includes("Invalid client secret");
      return {
        service: "m365",
        label: "Microsoft 365",
        status: "alarm",
        checkLatencyMs: elapsed,
        reason: isExpiredSecret ? "M365_CLIENT_SECRET expired — rotate in Azure portal" : `Token request failed: ${errText}`,
      };
    }
    return {
      service: "m365",
      label: "Microsoft 365",
      status: "ok",
      checkLatencyMs: elapsed,
      reason: "Token issued OK",
      notes: "Client secret expires every 24mo — track manually in Azure",
    };
  } catch (e: any) {
    return { service: "m365", label: "Microsoft 365", status: "warning", checkLatencyMs: Date.now() - t, reason: e?.message || String(e) };
  }
}

async function checkGoogle(): Promise<CredCheck> {
  const t = Date.now();
  const clientId = Netlify.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Netlify.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Netlify.env.get("G_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) return { service: "google", label: "Google (Gmail/Calendar)", status: "alarm", checkLatencyMs: 0, reason: "Google credentials missing" };
  try {
    const r = await withTimeout(() => fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    }), 5000, "Google OAuth");
    const elapsed = Date.now() - t;
    if (!r.ok) {
      const errText = (await r.text()).substring(0, 200);
      const revoked = errText.includes("invalid_grant");
      return {
        service: "google",
        label: "Google (Gmail/Calendar)",
        status: "alarm",
        checkLatencyMs: elapsed,
        reason: revoked ? "Refresh token revoked — re-auth via /auth/google flow" : `OAuth error: ${errText}`,
      };
    }
    return { service: "google", label: "Google (Gmail/Calendar)", status: "ok", checkLatencyMs: elapsed, reason: "Refresh token valid" };
  } catch (e: any) {
    return { service: "google", label: "Google (Gmail/Calendar)", status: "warning", checkLatencyMs: Date.now() - t, reason: e?.message || String(e) };
  }
}

async function checkZoom(): Promise<CredCheck> {
  const t = Date.now();
  const accountId = Netlify.env.get("ZOOM_ACCOUNT_ID");
  const clientId = Netlify.env.get("ZOOM_CLIENT_ID");
  const clientSecret = Netlify.env.get("ZOOM_CLIENT_SECRET");
  if (!accountId || !clientId || !clientSecret) return { service: "zoom", label: "Zoom", status: "alarm", checkLatencyMs: 0, reason: "Zoom credentials missing" };
  try {
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const r = await withTimeout(() => fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountId}`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}` },
    }), 5000, "Zoom OAuth");
    const elapsed = Date.now() - t;
    if (!r.ok) return { service: "zoom", label: "Zoom", status: "alarm", checkLatencyMs: elapsed, reason: `OAuth failed HTTP ${r.status}` };
    return { service: "zoom", label: "Zoom", status: "ok", checkLatencyMs: elapsed, reason: "Token issued OK" };
  } catch (e: any) {
    return { service: "zoom", label: "Zoom", status: "warning", checkLatencyMs: Date.now() - t, reason: e?.message || String(e) };
  }
}

async function checkResend(): Promise<CredCheck> {
  const t = Date.now();
  const key = Netlify.env.get("RESEND_API_KEY");
  if (!key) return { service: "resend", label: "Resend (email)", status: "alarm", checkLatencyMs: 0, reason: "RESEND_API_KEY missing" };
  try {
    const r = await withTimeout(() => fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${key}` },
    }), 5000, "Resend");
    const elapsed = Date.now() - t;
    if (r.status === 401) return { service: "resend", label: "Resend (email)", status: "alarm", checkLatencyMs: elapsed, reason: "API key rejected" };
    if (!r.ok) return { service: "resend", label: "Resend (email)", status: "warning", checkLatencyMs: elapsed, reason: `HTTP ${r.status}` };
    return { service: "resend", label: "Resend (email)", status: "ok", checkLatencyMs: elapsed, reason: "Key valid" };
  } catch (e: any) {
    return { service: "resend", label: "Resend (email)", status: "warning", checkLatencyMs: Date.now() - t, reason: e?.message || String(e) };
  }
}

async function checkGitHubPAT(): Promise<CredCheck> {
  const t = Date.now();
  const pat = Netlify.env.get("GITHUB_PAT");
  if (!pat) return { service: "github", label: "GitHub (backups)", status: "alarm", checkLatencyMs: 0, reason: "GITHUB_PAT missing" };
  try {
    // /user endpoint returns a header `github-authentication-token-expiration` for fine-grained tokens
    const r = await withTimeout(() => fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json", "User-Agent": "SAM-Watchdog" },
    }), 5000, "GitHub");
    const elapsed = Date.now() - t;
    if (r.status === 401) return { service: "github", label: "GitHub (backups)", status: "alarm", checkLatencyMs: elapsed, reason: "PAT revoked or expired" };
    if (!r.ok) return { service: "github", label: "GitHub (backups)", status: "warning", checkLatencyMs: elapsed, reason: `HTTP ${r.status}` };
    const expHeader = r.headers.get("github-authentication-token-expiration");
    let daysUntilExpiry: number | null = null;
    let expiresAt: string | null = null;
    if (expHeader) {
      const expDate = new Date(expHeader);
      if (!isNaN(expDate.getTime())) {
        expiresAt = expDate.toISOString();
        daysUntilExpiry = Math.round((expDate.getTime() - Date.now()) / 86400000);
      }
    }
    let status: CredCheck["status"] = "ok";
    let reason = "PAT valid";
    if (daysUntilExpiry !== null) {
      if (daysUntilExpiry <= 0) { status = "alarm"; reason = "PAT EXPIRED"; }
      else if (daysUntilExpiry <= 7) { status = "alarm"; reason = `PAT expires in ${daysUntilExpiry}d — rotate now`; }
      else if (daysUntilExpiry <= 30) { status = "warning"; reason = `PAT expires in ${daysUntilExpiry}d — schedule rotation`; }
      else { reason = `PAT valid · expires in ${daysUntilExpiry}d`; }
    }
    return { service: "github", label: "GitHub (backups)", status, checkLatencyMs: elapsed, reason, daysUntilExpiry, expiresAt };
  } catch (e: any) {
    return { service: "github", label: "GitHub (backups)", status: "warning", checkLatencyMs: Date.now() - t, reason: e?.message || String(e) };
  }
}

async function checkYahoo(): Promise<CredCheck> {
  // Yahoo uses IMAP — no cheap probe. We use the most recent yahoo-warmer heartbeat
  // as a proxy: if the warmer succeeded recently, the credential is good.
  const t = Date.now();
  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore({ name: "sam-cron-heartbeat", consistency: "strong" });
    const hb = (await store.get("yahoo-warmer", { type: "json" })) as any;
    const elapsed = Date.now() - t;
    if (!hb) {
      return { service: "yahoo", label: "Yahoo Mail", status: "warning", checkLatencyMs: elapsed, reason: "No yahoo-warmer heartbeat yet — will populate within 2 min", notes: "Inferred from warmer cron heartbeat (no cheap IMAP probe available)" };
    }
    const ageMs = Date.now() - new Date(hb.lastRunAt).getTime();
    if (ageMs > 10 * 60 * 1000) {
      return { service: "yahoo", label: "Yahoo Mail", status: "warning", checkLatencyMs: elapsed, reason: `Yahoo warmer last ran ${Math.round(ageMs/60000)}m ago — may indicate auth failure` };
    }
    if (!hb.lastSuccess) {
      const errBlob = (hb.lastError || "").toLowerCase();
      if (errBlob.includes("auth") || errBlob.includes("login") || errBlob.includes("password")) {
        return { service: "yahoo", label: "Yahoo Mail", status: "alarm", checkLatencyMs: elapsed, reason: `Auth failure: ${hb.lastError || "see logs"}` };
      }
      return { service: "yahoo", label: "Yahoo Mail", status: "warning", checkLatencyMs: elapsed, reason: `Last warmer run failed: ${hb.lastError || "unknown"}` };
    }
    return { service: "yahoo", label: "Yahoo Mail", status: "ok", checkLatencyMs: elapsed, reason: "Yahoo warmer last ran successfully", notes: "Inferred from warmer heartbeat" };
  } catch (e: any) {
    return { service: "yahoo", label: "Yahoo Mail", status: "unknown", checkLatencyMs: Date.now() - t, reason: e?.message || String(e) };
  }
}

export default async (req: Request, context: Context) => {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { "Content-Type": "application/json" },
    });
  }
  try {
    const t = Date.now();
    const checks = await Promise.all([
      checkAnthropic(),
      checkOpenAI(),
      checkGemini(),
      checkM365(),
      checkGoogle(),
      checkZoom(),
      checkResend(),
      checkGitHubPAT(),
      checkYahoo(),
    ]);
    const summary = {
      ok: checks.filter((c) => c.status === "ok").length,
      warning: checks.filter((c) => c.status === "warning").length,
      alarm: checks.filter((c) => c.status === "alarm").length,
      unknown: checks.filter((c) => c.status === "unknown").length,
      total: checks.length,
      overall: checks.some((c) => c.status === "alarm")
        ? "alarm" : checks.some((c) => c.status === "warning")
        ? "warning" : "ok",
      totalCheckMs: Date.now() - t,
    };
    return new Response(JSON.stringify({ credentials: checks, summary }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        // Cache 60s — credential checks are not free, don't repeat per-tab-switch
        "Cache-Control": "private, max-age=60, stale-while-revalidate=300",
      },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || String(e) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
};

export const config: Config = {
  path: "/api/credentials/health",
};
