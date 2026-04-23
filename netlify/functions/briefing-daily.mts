import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

/**
 * SAM PHASE 1.1 — MORNING BRIEFING ENGINE
 *
 * Runs at 6:00 AM ET every morning (10:00 UTC). Pulls the last 24 hours of
 * email across M365 + Gmail + Yahoo, today's calendar events from M365,
 * open tasks, and any recent Zoom transcripts. Sends everything to Claude
 * for synthesis into a decision-ready briefing. Emails the briefing to
 * David and archives a copy in Netlify Blobs for history.
 *
 * This is the flagship feature that turns SAM from reactive dashboard into
 * proactive Chief of Staff. David doesn't open SAM to find out what matters —
 * SAM tells him before he's finished his coffee.
 *
 * REQUIRED ENV VARS:
 *   M365_TENANT_ID, M365_CLIENT_ID, M365_CLIENT_SECRET, M365_USER_EMAIL
 *   ANTHROPIC_API_KEY
 *   RESEND_API_KEY
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, G_REFRESH_TOKEN
 *   YAHOO_EMAIL, YAHOO_APP_PASSWORD (optional — Yahoo skipped if missing)
 *
 * MANUAL INVOKE: POST /api/briefing/now  (for testing — doesn't wait for cron)
 * HISTORY:       GET  /api/briefing/history  (list past briefings)
 * READ ONE:      GET  /api/briefing/get?date=YYYY-MM-DD
 */

const OWNER_NAME = "Dr. Hatami";
const OWNER_EMAIL = "admin@edupolicy.ai";
const BRIEFING_FROM = "briefing@edupolicy.ai";
const TZ = "America/New_York";

// ============================================================
// HELPERS — one per data source. Each returns a compact string
// ready to drop into the Claude synthesis prompt.
// ============================================================

async function getM365Token(): Promise<string | null> {
  const tenantId = Netlify.env.get("M365_TENANT_ID");
  const clientId = Netlify.env.get("M365_CLIENT_ID");
  const clientSecret = Netlify.env.get("M365_CLIENT_SECRET");
  if (!tenantId || !clientId || !clientSecret) return null;

  const resp = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    }
  );
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.access_token;
}

async function fetchM365Inbox24h(): Promise<string> {
  try {
    const token = await getM365Token();
    if (!token) return "M365 inbox: credentials unavailable.";
    const userEmail = Netlify.env.get("M365_USER_EMAIL") || "";
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const url =
      `https://graph.microsoft.com/v1.0/users/${userEmail}/messages` +
      `?$filter=receivedDateTime ge ${since}` +
      `&$select=subject,from,receivedDateTime,bodyPreview,isRead` +
      `&$orderby=receivedDateTime desc&$top=30`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return `M365 inbox: error ${r.status}`;
    const d = await r.json();
    const msgs = d.value || [];
    if (!msgs.length) return "M365 inbox (24h): No new messages.";
    return (
      `M365 inbox (${msgs.length} messages in last 24h):\n` +
      msgs
        .slice(0, 20)
        .map((m: any) => {
          const from = m.from?.emailAddress?.address || "unknown";
          const name = m.from?.emailAddress?.name || from;
          const when = new Date(m.receivedDateTime).toLocaleString("en-US", {
            timeZone: TZ,
            hour: "numeric",
            minute: "2-digit",
            month: "short",
            day: "numeric",
          });
          const unread = m.isRead ? "" : "[UNREAD] ";
          return `- ${unread}${when} | ${name} <${from}> | ${m.subject || "(no subject)"}\n  preview: ${(m.bodyPreview || "").slice(0, 200).replace(/\s+/g, " ")}`;
        })
        .join("\n")
    );
  } catch (e: any) {
    return `M365 inbox: exception ${e.message}`;
  }
}

async function fetchGmail24h(): Promise<string> {
  try {
    const clientId = Netlify.env.get("GOOGLE_CLIENT_ID");
    const clientSecret = Netlify.env.get("GOOGLE_CLIENT_SECRET");
    const refreshToken = Netlify.env.get("G_REFRESH_TOKEN");
    if (!clientId || !clientSecret || !refreshToken)
      return "Gmail: credentials unavailable.";

    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!tokenResp.ok) return "Gmail: auth failed.";
    const { access_token } = await tokenResp.json();

    const listResp = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=newer_than:1d&maxResults=20",
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    if (!listResp.ok) return `Gmail: error ${listResp.status}`;
    const list = await listResp.json();
    const ids = (list.messages || []).map((m: any) => m.id);
    if (!ids.length) return "Gmail (24h): No new messages.";

    const details = await Promise.all(
      ids.slice(0, 15).map(async (id: string) => {
        const r = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${access_token}` } }
        );
        if (!r.ok) return null;
        const m = await r.json();
        const headers = m.payload?.headers || [];
        const h = (n: string) =>
          headers.find((x: any) => x.name === n)?.value || "";
        return {
          from: h("From"),
          subject: h("Subject"),
          date: h("Date"),
          snippet: m.snippet || "",
          unread: (m.labelIds || []).includes("UNREAD"),
        };
      })
    );
    const good = details.filter(Boolean);
    return (
      `Gmail (${good.length} messages in last 24h):\n` +
      good
        .map(
          (m: any) =>
            `- ${m.unread ? "[UNREAD] " : ""}${m.from} | ${m.subject}\n  snippet: ${m.snippet.slice(0, 200)}`
        )
        .join("\n")
    );
  } catch (e: any) {
    return `Gmail: exception ${e.message}`;
  }
}

async function fetchM365CalendarToday(): Promise<string> {
  try {
    const token = await getM365Token();
    if (!token) return "M365 calendar: credentials unavailable.";
    const userEmail = Netlify.env.get("M365_USER_EMAIL") || "";

    const now = new Date();
    const etFormatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric", month: "2-digit", day: "numeric",
    });
    const etDate = etFormatter.format(now); // YYYY-MM-DD in ET
    const dayStartET = new Date(`${etDate}T00:00:00-04:00`).toISOString();
    const dayEndET = new Date(`${etDate}T23:59:59-04:00`).toISOString();

    const url =
      `https://graph.microsoft.com/v1.0/users/${userEmail}/calendarView` +
      `?startDateTime=${dayStartET}&endDateTime=${dayEndET}` +
      `&$select=subject,start,end,location,attendees,bodyPreview,organizer` +
      `&$orderby=start/dateTime&$top=25`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Prefer: `outlook.timezone="${TZ}"` },
    });
    if (!r.ok) return `M365 calendar: error ${r.status}`;
    const d = await r.json();
    const events = d.value || [];
    if (!events.length) return "Today's calendar: No events scheduled.";
    return (
      `Today's calendar (${events.length} events):\n` +
      events
        .map((e: any) => {
          const s = new Date(e.start?.dateTime + (e.start?.timeZone === "UTC" ? "Z" : ""));
          const when = s.toLocaleTimeString("en-US", {
            timeZone: TZ,
            hour: "numeric",
            minute: "2-digit",
          });
          const loc = e.location?.displayName ? ` @ ${e.location.displayName}` : "";
          const org = e.organizer?.emailAddress?.name || "";
          const atts = (e.attendees || [])
            .slice(0, 4)
            .map((a: any) => a.emailAddress?.name || a.emailAddress?.address)
            .filter(Boolean)
            .join(", ");
          return `- ${when} | ${e.subject}${loc}${org ? ` | organizer: ${org}` : ""}${atts ? ` | with: ${atts}` : ""}`;
        })
        .join("\n")
    );
  } catch (e: any) {
    return `M365 calendar: exception ${e.message}`;
  }
}

async function fetchOpenTasks(): Promise<string> {
  try {
    const store = getStore({ name: "sam-tasks", consistency: "strong" });
    const { blobs } = await store.list();
    const tasks: any[] = [];
    for (const b of blobs) {
      try {
        const t = await store.get(b.key, { type: "json" });
        if (t && t.status !== "done" && t.status !== "completed") tasks.push(t);
      } catch {}
    }
    if (!tasks.length) return "Open tasks: None tracked.";
    const now = Date.now();
    const prioritized = tasks
      .map((t) => ({
        ...t,
        _overdue: t.dueDate && new Date(t.dueDate).getTime() < now,
      }))
      .sort((a, b) => {
        if (a._overdue !== b._overdue) return a._overdue ? -1 : 1;
        const pOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
        return (pOrder[a.priority] ?? 4) - (pOrder[b.priority] ?? 4);
      })
      .slice(0, 15);
    return (
      `Open tasks (${tasks.length} total, showing top ${prioritized.length}):\n` +
      prioritized
        .map((t) => {
          const tag = t._overdue ? "[OVERDUE] " : "";
          const due = t.dueDate
            ? ` | due ${new Date(t.dueDate).toLocaleDateString("en-US", { timeZone: TZ })}`
            : "";
          const proj = t.project ? ` | project: ${t.project}` : "";
          return `- ${tag}${(t.priority || "medium").toUpperCase()} | ${t.title}${due}${proj}`;
        })
        .join("\n")
    );
  } catch (e: any) {
    return `Open tasks: exception ${e.message}`;
  }
}

async function fetchRecentZoomTranscripts(): Promise<string> {
  try {
    const store = getStore({ name: "sam-zoom-transcripts", consistency: "strong" });
    const { blobs } = await store.list();
    const since = Date.now() - 24 * 3600 * 1000;
    const recent: any[] = [];
    for (const b of blobs.slice(0, 50)) {
      try {
        const t = await store.get(b.key, { type: "json" });
        if (t && t.meetingDate && new Date(t.meetingDate).getTime() > since) {
          recent.push(t);
        }
      } catch {}
    }
    if (!recent.length) return "Zoom transcripts (24h): None available.";
    return (
      `Recent Zoom transcripts (${recent.length}):\n` +
      recent
        .slice(0, 3)
        .map(
          (t: any) =>
            `- ${t.topic || "untitled"} (${new Date(t.meetingDate).toLocaleString("en-US", { timeZone: TZ })})\n  transcript excerpt: ${(t.transcript || "").slice(0, 500).replace(/\s+/g, " ")}`
        )
        .join("\n")
    );
  } catch (e: any) {
    return `Zoom transcripts: (not yet indexed — skipping)`;
  }
}

// ============================================================
// CLAUDE SYNTHESIS
// ============================================================

async function synthesizeBriefing(sections: {
  m365Inbox: string;
  gmail: string;
  calendar: string;
  tasks: string;
  transcripts: string;
}): Promise<string> {
  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const todayET = new Date().toLocaleDateString("en-US", {
    timeZone: TZ,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const systemPrompt = `You are SAM (Secret Agent Man), Dr. David Hatami's Chief of Staff. You're writing his morning briefing — the first thing he reads with his coffee at 6 AM ET. He is an AI Ethics consultant and higher education executive. Consulting clients are active; do not name them unless they appear directly in today's data.

Tone: crisp, direct, intelligent. Write like a sharp executive assistant briefing the boss. No corporate wallpaper, no hedging, no "I hope this finds you well." Use paragraphs, not bullet points except where a genuine list is warranted. Short sentences mixed with longer ones. British-adjacent professional — you trust his intelligence.

Forbidden words: landscape, navigate, comprehensive, multifaceted, leverage, utilize, facilitate, robust, streamline, cutting-edge, innovative, transformative, holistic, synergy, methodology, framework (unless named), ecosystem, bandwidth, deep dive, unpack, delve, realm, testament, underscores, pivotal, nuanced, foster.

Structure the briefing in four sections with simple markdown headers:

## THE TOP
The single most important thing he needs to know or do today. One to three sentences. If nothing urgent, say so.

## TODAY'S SCHEDULE
His calendar, in natural prose. Call out conflicts, tight gaps, or meetings that need prep. Flag any meeting where you don't know the agenda.

## INBOX TRIAGE
Emails from the last 24 hours. Group by urgency: needs response today, needs response this week, FYI. Name senders. If you see anything from a client, investor, or institution — call it out specifically. Ignore newsletters, receipts, and automated notifications unless they're actually important.

## OPEN LOOPS
Overdue tasks, stalled commitments, things slipping. Be honest. If something's been sitting for a week, say so.

End with one line: what SAM recommends he tackle first this morning.

Never make up facts. If data is missing, say "no data available for X." Never invent email senders, meeting topics, or task details.`;

  const userPrompt = `Date: ${todayET}

=== M365 INBOX (last 24h) ===
${sections.m365Inbox}

=== GMAIL (last 24h) ===
${sections.gmail}

=== TODAY'S CALENDAR ===
${sections.calendar}

=== OPEN TASKS ===
${sections.tasks}

=== RECENT ZOOM TRANSCRIPTS (last 24h) ===
${sections.transcripts}

Write the briefing.`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-opus-4-5",
      max_tokens: 2500,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Claude synthesis failed: ${resp.status} ${err}`);
  }
  const data = await resp.json();
  return data.content?.[0]?.text || "(synthesis returned no content)";
}

// ============================================================
// EMAIL DELIVERY via Resend
// ============================================================

async function sendBriefingEmail(markdownBody: string, dateLabel: string) {
  const apiKey = Netlify.env.get("RESEND_API_KEY");
  if (!apiKey) throw new Error("RESEND_API_KEY not configured");

  // Convert markdown → simple HTML
  const html = markdownToHtml(markdownBody);
  const wrapped = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>SAM Briefing — ${dateLabel}</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 720px; margin: 0 auto; padding: 24px; color: #1a1a1a; line-height: 1.6;">
  <div style="border-bottom: 2px solid #2563eb; padding-bottom: 14px; margin-bottom: 24px;">
    <div style="font-size: 12px; color: #6b7280; letter-spacing: 1px; text-transform: uppercase;">SAM — Chief of Staff</div>
    <h1 style="font-size: 22px; margin: 6px 0 0 0; color: #111827;">Morning Briefing · ${dateLabel}</h1>
  </div>
  ${html}
  <div style="margin-top: 36px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 11px; color: #6b7280;">
    Generated by SAM at <a href="https://sam-chief-of-staff.netlify.app" style="color: #2563eb;">sam-chief-of-staff.netlify.app</a>.
    Data sources: M365 · Gmail · Calendar · Tasks · Zoom.
  </div>
</body>
</html>`;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: `SAM <${BRIEFING_FROM}>`,
      to: [OWNER_EMAIL],
      subject: `☕ Morning Briefing — ${dateLabel}`,
      html: wrapped,
      text: markdownBody,
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Resend failed: ${resp.status} ${err}`);
  }
  return await resp.json();
}

function markdownToHtml(md: string): string {
  // minimal markdown: ## headers, **bold**, line breaks, paragraphs
  const lines = md.split("\n");
  const out: string[] = [];
  let inPara = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (inPara) { out.push("</p>"); inPara = false; }
      continue;
    }
    if (line.startsWith("## ")) {
      if (inPara) { out.push("</p>"); inPara = false; }
      out.push(`<h2 style="font-size:15px;font-weight:700;margin:24px 0 10px;color:#2563eb;text-transform:uppercase;letter-spacing:0.5px;">${escapeHtml(line.slice(3))}</h2>`);
    } else if (line.startsWith("# ")) {
      if (inPara) { out.push("</p>"); inPara = false; }
      out.push(`<h1 style="font-size:18px;font-weight:700;margin:20px 0 12px;">${escapeHtml(line.slice(2))}</h1>`);
    } else if (line.startsWith("- ")) {
      if (inPara) { out.push("</p>"); inPara = false; }
      out.push(`<div style="margin:4px 0 4px 18px;">• ${formatInline(line.slice(2))}</div>`);
    } else {
      if (!inPara) { out.push(`<p style="margin:10px 0;">`); inPara = true; }
      else out.push(" ");
      out.push(formatInline(line));
    }
  }
  if (inPara) out.push("</p>");
  return out.join("");
}
function formatInline(s: string): string {
  return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ============================================================
// MAIN BRIEFING ORCHESTRATOR
// ============================================================

async function buildAndSendBriefing(): Promise<{ ok: true; key: string; preview: string }> {
  const startedAt = new Date();
  const dateKey = startedAt.toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
  const dateLabel = startedAt.toLocaleDateString("en-US", {
    timeZone: TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  // Fetch all sources in parallel — a briefing shouldn't take 2 minutes.
  const [m365Inbox, gmail, calendar, tasks, transcripts] = await Promise.all([
    fetchM365Inbox24h(),
    fetchGmail24h(),
    fetchM365CalendarToday(),
    fetchOpenTasks(),
    fetchRecentZoomTranscripts(),
  ]);

  const briefing = await synthesizeBriefing({
    m365Inbox, gmail, calendar, tasks, transcripts,
  });

  await sendBriefingEmail(briefing, dateLabel);

  // Archive to Blobs so the dashboard can show history
  const store = getStore({ name: "sam-briefings", consistency: "strong" });
  const archive = {
    date: dateKey,
    dateLabel,
    generatedAt: startedAt.toISOString(),
    briefing,
    sources: { m365Inbox, gmail, calendar, tasks, transcripts },
    durationMs: Date.now() - startedAt.getTime(),
  };
  await store.setJSON(dateKey, archive);

  return { ok: true, key: dateKey, preview: briefing.slice(0, 300) };
}

// ============================================================
// ROUTING — scheduled invocation + manual trigger + history
// ============================================================

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const path = url.pathname;

  // Scheduled cron invocation — no path match, fires the briefing
  if (req.method === "POST" && !path.startsWith("/api/briefing")) {
    try {
      const result = await buildAndSendBriefing();
      return new Response(JSON.stringify(result), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    } catch (e: any) {
      console.error("Scheduled briefing failed:", e);
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }
  }

  // Manual trigger — useful for testing before 6 AM
  if (path === "/api/briefing/now" && req.method === "POST") {
    try {
      const result = await buildAndSendBriefing();
      return new Response(JSON.stringify(result), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message, stack: e.stack }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }
  }

  // History listing
  if (path === "/api/briefing/history" && req.method === "GET") {
    try {
      const store = getStore({ name: "sam-briefings", consistency: "strong" });
      const { blobs } = await store.list();
      const dates = blobs.map((b: any) => b.key).sort().reverse().slice(0, 30);
      return new Response(JSON.stringify({ dates }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }
  }

  // Read a specific briefing
  if (path === "/api/briefing/get" && req.method === "GET") {
    const date = url.searchParams.get("date");
    if (!date) {
      return new Response(JSON.stringify({ error: "Missing date param (YYYY-MM-DD)" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }
    try {
      const store = getStore({ name: "sam-briefings", consistency: "strong" });
      const data = await store.get(date, { type: "json" });
      if (!data) {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(data), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }
  }

  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404, headers: { "Content-Type": "application/json" },
  });
};

// ============================================================
// CONFIG — schedule + path routing
// ============================================================

export const config: Config = {
  // Cron: every day at 10:00 UTC = 6:00 AM EDT (summer) / 5:00 AM EST (winter).
  // We live with that ±1 hour seasonal drift rather than doubling the function.
  schedule: "0 10 * * *",
  path: ["/api/briefing/now", "/api/briefing/history", "/api/briefing/get"],
};
