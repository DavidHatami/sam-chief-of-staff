import type { Context, Config } from "@netlify/functions";

/**
 * SAM POST-DEPLOY SMOKE TEST
 *
 *   GET  /api/smoke-test          → run all checks, return JSON report
 *   POST /api/smoke-test          → same as GET (used as Netlify deploy webhook)
 *
 * Hits every read-only endpoint, validates response shape, reports per-check
 * pass/fail. If anything fails, sends an alert email via Resend so David
 * sees regressions within minutes of any deploy.
 *
 * To wire as a deploy verification:
 *   Netlify dashboard → Site settings → Build & deploy → Deploy notifications
 *   → Add notification → "Outgoing webhook" → Event: "Deploy succeeded"
 *   → URL: https://sam-chief-of-staff.netlify.app/api/smoke-test
 *
 * That fires this function automatically after every successful deploy.
 */

interface CheckResult {
  endpoint: string;
  status: "pass" | "fail";
  httpCode: number;
  latencyMs: number;
  reason: string;
}

const SITE = "https://sam-chief-of-staff.netlify.app";

// Each entry: [endpoint, validator function]. Validator returns null on pass, error string on fail.
const CHECKS: { endpoint: string; validate: (json: any) => string | null }[] = [
  {
    endpoint: "/api/triage/pending",
    validate: (j) => Array.isArray(j?.pending) ? null : `Missing 'pending' array (got ${typeof j?.pending})`,
  },
  {
    endpoint: "/api/conflicts/open",
    validate: (j) => Array.isArray(j?.conflicts) ? null : `Missing 'conflicts' array`,
  },
  {
    endpoint: "/api/briefing/history",
    validate: (j) => Array.isArray(j?.dates) ? null : `Missing 'dates' array`,
  },
  {
    endpoint: "/api/review/history",
    validate: (j) => Array.isArray(j?.dates) ? null : `Missing 'dates' array`,
  },
  {
    endpoint: "/api/transcripts/summaries",
    validate: (j) => Array.isArray(j?.summaries) ? null : `Missing 'summaries' array`,
  },
  {
    endpoint: "/api/decisions",
    validate: (j) => Array.isArray(j?.decisions) ? null : `Missing 'decisions' array`,
  },
  {
    endpoint: "/api/unified-inbox",
    validate: (j) => Array.isArray(j?.messages) ? null : `Missing 'messages' array`,
  },
  {
    endpoint: "/api/tasks/",
    validate: (j) => Array.isArray(j?.tasks) || Array.isArray(j) ? null : `Tasks not array`,
  },
  {
    endpoint: "/api/projects",
    validate: (j) => Array.isArray(j?.projects) || Array.isArray(j) ? null : `Projects not array`,
  },
  {
    endpoint: "/api/instructions",
    validate: (j) => j && typeof j === "object" ? null : `Not an object`,
  },
  {
    endpoint: "/api/backup",
    validate: (j) => "lastBackup" in (j || {}) ? null : `Missing 'lastBackup' key`,
  },
  {
    endpoint: "/api/m365/calendar",
    validate: (j) => Array.isArray(j?.value) || Array.isArray(j) ? null : `Calendar not array`,
  },
  {
    endpoint: "/api/m365/mail?folder=inbox&top=5",
    validate: (j) => Array.isArray(j?.value) ? null : `Missing 'value' array`,
  },
  {
    endpoint: "/api/gmail/mail?folder=inbox&top=5",
    validate: (j) => Array.isArray(j?.value) ? null : `Missing 'value' array`,
  },
  {
    endpoint: "/api/yahoo-fast/mail?folder=inbox&top=5",
    validate: (j) => Array.isArray(j?.value) ? null : `Missing 'value' array (yahoo-fast snapshot may not be warm yet — yahoo-warmer fires every 2min)`,
  },
  {
    endpoint: "/api/gcal/events",
    validate: (j) => Array.isArray(j?.events) || Array.isArray(j) ? null : `Events not array`,
  },
  {
    endpoint: "/api/zoom/recordings",
    validate: (j) => Array.isArray(j?.recordings) || Array.isArray(j?.meetings) || Array.isArray(j) ? null : `Recordings not array`,
  },
  {
    endpoint: "/api/cron/health",
    validate: (j) => Array.isArray(j?.jobs) ? null : `Missing 'jobs' array`,
  },
  {
    endpoint: "/api/credentials/health",
    validate: (j) => Array.isArray(j?.credentials) ? null : `Missing 'credentials' array`,
  },
];

async function runOne(endpoint: string, validate: (j: any) => string | null): Promise<CheckResult> {
  const t = Date.now();
  // Three retries with backoff to ride through Netlify edge 503s
  let lastCode = 0;
  let lastReason = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25000);
      const r = await fetch(`${SITE}${endpoint}?_smoke=${Date.now()}-${attempt}`, {
        signal: ctrl.signal,
        headers: { "User-Agent": "SAM-Smoke-Test" },
      });
      clearTimeout(timer);
      lastCode = r.status;
      if (!r.ok) {
        lastReason = `HTTP ${r.status}`;
        if (r.status === 503 && attempt < 3) {
          await new Promise((res) => setTimeout(res, 1500 * attempt));
          continue;
        }
        return { endpoint, status: "fail", httpCode: r.status, latencyMs: Date.now() - t, reason: lastReason };
      }
      const json = await r.json().catch(() => null);
      if (!json) {
        return { endpoint, status: "fail", httpCode: r.status, latencyMs: Date.now() - t, reason: "Body not JSON" };
      }
      const validateError = validate(json);
      if (validateError) {
        return { endpoint, status: "fail", httpCode: r.status, latencyMs: Date.now() - t, reason: `Schema: ${validateError}` };
      }
      return { endpoint, status: "pass", httpCode: r.status, latencyMs: Date.now() - t, reason: "OK" };
    } catch (e: any) {
      lastReason = e?.message || String(e);
      if (attempt < 3) {
        await new Promise((res) => setTimeout(res, 1500 * attempt));
        continue;
      }
    }
  }
  return { endpoint, status: "fail", httpCode: lastCode, latencyMs: Date.now() - t, reason: lastReason };
}

async function sendSmokeFailureAlert(results: CheckResult[], deployId: string | null) {
  const apiKey = Netlify.env.get("RESEND_API_KEY");
  if (!apiKey) return;
  const fails = results.filter((r) => r.status === "fail");
  if (fails.length === 0) return;

  const rows = fails
    .map((r) => `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;font-family:monospace;font-size:12px;color:#fff;">${r.endpoint}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;color:#E24B4A;font-weight:600;font-size:12px;">FAIL</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;color:#aaa;font-size:12px;">HTTP ${r.httpCode}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;color:#aaa;font-size:12px;">${r.latencyMs}ms</td>
      <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;color:#ccc;font-size:12px;">${r.reason}</td>
    </tr>`)
    .join("");

  const html = `<!DOCTYPE html><html><body style="background:#0e0e10;color:#e8e8ea;font-family:-apple-system,sans-serif;padding:20px;">
    <div style="max-width:760px;margin:0 auto;background:#1a1a1f;border:1px solid #2a2a2a;border-radius:10px;padding:24px;">
      <h2 style="margin:0 0 6px 0;color:#fff;">⚠ SAM Post-Deploy Smoke Test FAILED</h2>
      <div style="color:#888;font-size:12px;margin-bottom:18px;font-family:monospace;">${fails.length} of ${results.length} checks failed${deployId ? ` · deploy ${deployId.substring(0,8)}` : ""}</div>
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr>
          <th style="text-align:left;padding:8px 12px;border-bottom:1px solid #444;color:#888;font-size:11px;text-transform:uppercase;">Endpoint</th>
          <th style="text-align:left;padding:8px 12px;border-bottom:1px solid #444;color:#888;font-size:11px;text-transform:uppercase;">Status</th>
          <th style="text-align:left;padding:8px 12px;border-bottom:1px solid #444;color:#888;font-size:11px;text-transform:uppercase;">HTTP</th>
          <th style="text-align:left;padding:8px 12px;border-bottom:1px solid #444;color:#888;font-size:11px;text-transform:uppercase;">Latency</th>
          <th style="text-align:left;padding:8px 12px;border-bottom:1px solid #444;color:#888;font-size:11px;text-transform:uppercase;">Reason</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="margin-top:18px;padding:12px;background:#0e0e10;border-radius:6px;font-size:12px;color:#888;line-height:1.5;">
        <b style="color:#aaa;">Action:</b> Open <a href="https://app.netlify.com/projects/sam-chief-of-staff/deploys" style="color:#4a7cff;">Netlify Deploys</a>. If the regression is real, roll back via "Publish deploy" on the prior good build (RUNBOOK §4).
      </div>
    </div>
  </body></html>`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "SAM Smoke Test <onboarding@resend.dev>",
      to: ["admin@edupolicy.ai"],
      subject: `⚠ SAM smoke test FAILED: ${fails.length}/${results.length} checks regressed`,
      html,
    }),
  }).catch(() => {});
}

async function persistRunReport(results: CheckResult[], deployId: string | null) {
  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore({ name: "sam-smoke-test", consistency: "strong" });
    const summary = {
      runAt: new Date().toISOString(),
      deployId,
      total: results.length,
      passed: results.filter((r) => r.status === "pass").length,
      failed: results.filter((r) => r.status === "fail").length,
      results,
    };
    // Keep last run + run-history (keyed by ISO timestamp for ordering)
    await store.setJSON("last", summary);
    await store.setJSON(summary.runAt, summary);
  } catch {}
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);

  // Read-only mode: GET ?last=1 returns the cached result of the most recent run
  // without triggering a fresh run. Used by the dashboard widget so it doesn't
  // burn 10+ seconds every time the dashboard loads.
  if (req.method === "GET" && url.searchParams.get("last") === "1") {
    try {
      const { getStore } = await import("@netlify/blobs");
      const store = getStore({ name: "sam-smoke-test", consistency: "strong" });
      const last = await store.get("last", { type: "json" });
      if (!last) {
        return new Response(JSON.stringify({ summary: null, results: [], note: "No smoke test has run yet" }), {
          status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=30" },
        });
      }
      return new Response(JSON.stringify(last), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=30" },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e?.message || String(e) }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }
  }

  // Netlify deploy webhooks send POST with deploy info in the body.
  let deployId: string | null = null;
  if (req.method === "POST") {
    try {
      const body: any = await req.json();
      deployId = body?.id || body?.deploy?.id || null;
    } catch {}
  }

  const startedAt = Date.now();
  const results = await Promise.all(CHECKS.map((c) => runOne(c.endpoint, c.validate)));
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const totalMs = Date.now() - startedAt;

  // Persist + alert
  await persistRunReport(results, deployId);
  if (failed > 0) {
    await sendSmokeFailureAlert(results, deployId);
  }

  return new Response(
    JSON.stringify({
      summary: {
        passed,
        failed,
        total: results.length,
        durationMs: totalMs,
        deployId,
        verdict: failed === 0 ? "all green" : `${failed} regression${failed === 1 ? "" : "s"}`,
      },
      results,
    }, null, 2),
    {
      status: failed === 0 ? 200 : 500,
      headers: {
        "Content-Type": "application/json",
        // No caching — every call is a fresh test run
        "Cache-Control": "no-store",
      },
    }
  );
};

export const config: Config = {
  path: "/api/smoke-test",
};
