import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { buildHealthReport, type JobStatus, type HealthReport } from "../lib/cron-heartbeat.ts";

/**
 * SAM CRON WATCHDOG — scheduled (hourly)
 *
 * Reads heartbeats. If any job is stale or repeatedly failing, sends one
 * digest email via Resend. Re-alerts at most every 6 hours so a long outage
 * doesn't spam the inbox.
 */

async function shouldAlert(): Promise<boolean> {
  const store = getStore({ name: "sam-cron-heartbeat", consistency: "strong" });
  try {
    const last = (await store.get("_last_alert", { type: "json" })) as { at: string } | null;
    if (!last) return true;
    const ageMs = Date.now() - new Date(last.at).getTime();
    return ageMs > 6 * 60 * 60 * 1000;
  } catch {
    return true;
  }
}

async function recordAlertSent() {
  const store = getStore({ name: "sam-cron-heartbeat", consistency: "strong" });
  try { await store.setJSON("_last_alert", { at: new Date().toISOString() }); } catch {}
}

async function sendStaleCronAlert(report: HealthReport) {
  const apiKey = Netlify.env.get("RESEND_API_KEY");
  if (!apiKey) {
    console.log("[CRON-WATCHDOG] RESEND_API_KEY missing — cannot alert");
    return;
  }
  const stale = report.jobs.filter((j: JobStatus) => j.status !== "ok");
  if (stale.length === 0) return;

  const rows = stale
    .map((j: JobStatus) => {
      const color = j.status === "alarm" ? "#E24B4A" : "#EF9F27";
      const last = j.lastRunAt
        ? new Date(j.lastRunAt).toLocaleString("en-US", { timeZone: "America/New_York" })
        : "(never)";
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;font-family:monospace;font-size:13px;color:#fff;">${j.job}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;color:${color};font-weight:600;font-size:13px;">${j.status.toUpperCase()}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;color:#aaa;font-size:13px;">${last}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;color:#ccc;font-size:13px;">${j.reason}</td>
      </tr>`;
    })
    .join("");

  const html = `<!DOCTYPE html><html><body style="background:#0e0e10;color:#e8e8ea;font-family:-apple-system,sans-serif;padding:20px;">
    <div style="max-width:680px;margin:0 auto;background:#1a1a1f;border:1px solid #2a2a2a;border-radius:10px;padding:24px;">
      <h2 style="margin:0 0 6px 0;color:#fff;">⚠ SAM Cron Watchdog</h2>
      <div style="color:#888;font-size:12px;margin-bottom:18px;font-family:monospace;">${stale.length} of ${report.summary.total} jobs need attention · ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET</div>
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr>
          <th style="text-align:left;padding:8px 12px;border-bottom:1px solid #444;color:#888;font-size:11px;text-transform:uppercase;">Job</th>
          <th style="text-align:left;padding:8px 12px;border-bottom:1px solid #444;color:#888;font-size:11px;text-transform:uppercase;">State</th>
          <th style="text-align:left;padding:8px 12px;border-bottom:1px solid #444;color:#888;font-size:11px;text-transform:uppercase;">Last Run</th>
          <th style="text-align:left;padding:8px 12px;border-bottom:1px solid #444;color:#888;font-size:11px;text-transform:uppercase;">Reason</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="margin-top:18px;padding:12px;background:#0e0e10;border-radius:6px;font-size:12px;color:#888;line-height:1.5;">
        <b style="color:#aaa;">Next steps:</b> open <a href="https://sam-chief-of-staff.netlify.app" style="color:#4a7cff;">SAM dashboard</a> → check the Cron Health card. For ALARM jobs, check Netlify Functions logs at <a href="https://app.netlify.com/projects/sam-chief-of-staff/logs/functions" style="color:#4a7cff;">Functions log</a>.
      </div>
    </div>
  </body></html>`;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "SAM Watchdog <onboarding@resend.dev>",
      to: ["admin@edupolicy.ai"],
      subject: `⚠ SAM cron alert: ${stale.length} job${stale.length === 1 ? "" : "s"} need attention`,
      html,
    }),
  });
  if (!resp.ok) {
    console.error(`[CRON-WATCHDOG] Resend send failed: ${resp.status} ${await resp.text()}`);
  } else {
    console.log(`[CRON-WATCHDOG] Alert sent — ${stale.length} stale/failing jobs`);
  }
}

export default async (req: Request, context: Context) => {
  try {
    const report = await buildHealthReport();
    const stale = report.jobs.filter((j) => j.status !== "ok");
    if (stale.length === 0) {
      console.log("[CRON-WATCHDOG] All clear — 7/7 jobs healthy");
      return;
    }
    if (!(await shouldAlert())) {
      console.log(`[CRON-WATCHDOG] ${stale.length} stale jobs but alert sent recently — suppressing`);
      return;
    }
    await sendStaleCronAlert(report);
    await recordAlertSent();
  } catch (e: any) {
    console.error("[CRON-WATCHDOG] check failed:", e?.message, e?.stack);
  }
};

export const config: Config = {
  schedule: "0 * * * *",  // top of every hour
};
