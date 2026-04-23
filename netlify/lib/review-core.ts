import { getStore } from "@netlify/blobs";

/**
 * SAM PHASE 2.3 — WEEKLY REVIEW GENERATOR
 *
 * Every Sunday at 22:00 UTC (6 PM ET) SAM looks back over the past 7 days
 * and forward 7 days, synthesizes a written review, emails it to David,
 * and archives it to the sam-reviews blob store + sam-ops backup.
 *
 * Sections:
 *   - What Got Done:  completed tasks, meetings held, key wins
 *   - What Slipped:   overdue tasks, unanswered emails, missed commitments
 *   - Relationships: who you talked to this week, who you didn't but should have
 *   - Decisions:     captured from meeting transcripts
 *   - Coming Up:     next week's calendar and deadline landscape
 *   - Recommendation: one sentence on where to focus the week ahead
 *
 * Writing style matches the morning briefing — direct, no corporate
 * wallpaper, banned-word list enforced.
 */

export const TZ = "America/New_York";
export const OWNER_EMAIL = "admin@edupolicy.ai";
export const REVIEW_FROM = "review@edupolicy.ai";

// ============================================================
// AUTH
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
  return (await resp.json()).access_token;
}

// ============================================================
// DATA SECTION FETCHERS — each returns a compact string for Claude
// ============================================================

async function fetchWeekEmails(): Promise<string> {
  try {
    const token = await getM365Token();
    if (!token) return "Email week summary: credentials unavailable.";
    const userEmail = Netlify.env.get("M365_USER_EMAIL") || "";
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

    const inboxUrl =
      `https://graph.microsoft.com/v1.0/users/${userEmail}/messages` +
      `?$filter=receivedDateTime ge ${since}` +
      `&$select=from,receivedDateTime,subject,isRead&$top=100`;
    const sentUrl =
      `https://graph.microsoft.com/v1.0/users/${userEmail}/mailFolders/SentItems/messages` +
      `?$filter=sentDateTime ge ${since}` +
      `&$select=toRecipients,sentDateTime,subject&$top=100`;

    const [ibR, sentR] = await Promise.all([
      fetch(inboxUrl, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(sentUrl, { headers: { Authorization: `Bearer ${token}` } }),
    ]);
    const inbox = ibR.ok ? ((await ibR.json()).value || []) : [];
    const sent = sentR.ok ? ((await sentR.json()).value || []) : [];

    // Build domain frequency
    const fromDomains: Record<string, number> = {};
    const unreadFromDomains: Record<string, number> = {};
    for (const m of inbox) {
      const d = (m.from?.emailAddress?.address || "").split("@")[1] || "unknown";
      fromDomains[d] = (fromDomains[d] || 0) + 1;
      if (!m.isRead) unreadFromDomains[d] = (unreadFromDomains[d] || 0) + 1;
    }
    const toDomains: Record<string, number> = {};
    for (const m of sent) {
      for (const r of m.toRecipients || []) {
        const d = (r.emailAddress?.address || "").split("@")[1] || "unknown";
        toDomains[d] = (toDomains[d] || 0) + 1;
      }
    }
    const topInbound = Object.entries(fromDomains)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([d, n]) => `  ${d}: ${n}${unreadFromDomains[d] ? ` (${unreadFromDomains[d]} unread)` : ""}`)
      .join("\n");
    const topOutbound = Object.entries(toDomains)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([d, n]) => `  ${d}: ${n}`)
      .join("\n");

    return `Emails this week:
Received: ${inbox.length} total, ${inbox.filter((m: any) => !m.isRead).length} unread.
Sent: ${sent.length} total.

Top inbound domains:
${topInbound || "  (none)"}

Top outbound domains:
${topOutbound || "  (none)"}`;
  } catch (e: any) {
    return `Emails this week: exception ${e.message}`;
  }
}

async function fetchWeekCalendar(direction: "past" | "next"): Promise<string> {
  try {
    const token = await getM365Token();
    if (!token) return `Calendar ${direction}: credentials unavailable.`;
    const userEmail = Netlify.env.get("M365_USER_EMAIL") || "";
    const now = Date.now();
    const start =
      direction === "past"
        ? new Date(now - 7 * 24 * 3600 * 1000).toISOString()
        : new Date(now).toISOString();
    const end =
      direction === "past"
        ? new Date(now).toISOString()
        : new Date(now + 7 * 24 * 3600 * 1000).toISOString();

    const url =
      `https://graph.microsoft.com/v1.0/users/${userEmail}/calendarView` +
      `?startDateTime=${start}&endDateTime=${end}` +
      `&$select=subject,start,end,attendees,organizer` +
      `&$orderby=start/dateTime&$top=100`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Prefer: `outlook.timezone="${TZ}"` },
    });
    if (!r.ok) return `Calendar ${direction}: error ${r.status}`;
    const d = await r.json();
    const events = d.value || [];
    if (!events.length) return `Calendar ${direction} 7 days: no events.`;
    return (
      `Calendar ${direction} 7 days (${events.length} events):\n` +
      events
        .slice(0, 30)
        .map((e: any) => {
          const s = new Date(e.start?.dateTime + "Z");
          const day = s.toLocaleDateString("en-US", {
            timeZone: TZ,
            weekday: "short",
            month: "short",
            day: "numeric",
          });
          const time = s.toLocaleTimeString("en-US", {
            timeZone: TZ,
            hour: "numeric",
            minute: "2-digit",
          });
          const atts = (e.attendees || [])
            .slice(0, 3)
            .map((a: any) => a.emailAddress?.name || a.emailAddress?.address)
            .filter(Boolean)
            .join(", ");
          return `- ${day} ${time} | ${e.subject || "(untitled)"}${atts ? ` | with: ${atts}` : ""}`;
        })
        .join("\n")
    );
  } catch (e: any) {
    return `Calendar ${direction}: exception ${e.message}`;
  }
}

async function fetchWeekTasks(): Promise<string> {
  try {
    const store = getStore({ name: "sam-tasks", consistency: "eventual" });
    const { blobs } = await store.list();
    const since = Date.now() - 7 * 24 * 3600 * 1000;
    const completed: any[] = [];
    const overdue: any[] = [];
    const openActive: any[] = [];
    const now = Date.now();
    for (const b of blobs) {
      try {
        const t = (await store.get(b.key, { type: "json" })) as any;
        if (!t) continue;
        const isDone = t.status === "done" || t.status === "completed";
        const completedAt = t.completedAt ? new Date(t.completedAt).getTime() : 0;
        if (isDone && completedAt >= since) completed.push(t);
        else if (!isDone) {
          const due = t.dueDate ? new Date(t.dueDate).getTime() : 0;
          if (due && due < now) overdue.push(t);
          else openActive.push(t);
        }
      } catch {}
    }
    return `Tasks this week:
Completed this week: ${completed.length}
  ${completed.slice(0, 10).map((t) => `- ${t.title}`).join("\n  ") || "(none)"}

Overdue right now: ${overdue.length}
  ${overdue.slice(0, 10).map((t) => `- ${t.title} (due ${t.dueDate})`).join("\n  ") || "(none)"}

Active, not yet due: ${openActive.length}`;
  } catch (e: any) {
    return `Tasks this week: exception ${e.message}`;
  }
}

async function fetchWeekDecisions(): Promise<string> {
  try {
    const store = getStore({ name: "sam-decisions", consistency: "eventual" });
    const { blobs } = await store.list();
    const since = Date.now() - 7 * 24 * 3600 * 1000;
    const recent: any[] = [];
    for (const b of blobs) {
      try {
        const d = (await store.get(b.key, { type: "json" })) as any;
        if (!d) continue;
        const when = d.decidedAt ? new Date(d.decidedAt).getTime() : 0;
        if (when >= since) recent.push(d);
      } catch {}
    }
    if (!recent.length) return "Decisions this week: none captured.";
    return (
      `Decisions this week (${recent.length}):\n` +
      recent
        .slice(0, 15)
        .map((d) => `- ${d.summary}${d.reasoning ? ` (why: ${d.reasoning.slice(0, 100)})` : ""}`)
        .join("\n")
    );
  } catch (e: any) {
    return `Decisions this week: exception ${e.message}`;
  }
}

// ============================================================
// CLAUDE SYNTHESIS
// ============================================================

async function synthesizeReview(sections: {
  emails: string;
  past: string;
  next: string;
  tasks: string;
  decisions: string;
  weekLabel: string;
}): Promise<string> {
  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const systemPrompt = `You are SAM (Secret Agent Man), Dr. David Hatami's Chief of Staff. You're writing the weekly review — sent Sunday evening so David heads into the next week clear-eyed about what happened and what's coming.

Tone: crisp, direct, intelligent. No corporate wallpaper. No hedging. Paragraphs over bullets except when a genuine list is warranted. Short sentences mixed with longer ones.

Forbidden words: landscape, navigate, comprehensive, multifaceted, leverage, utilize, facilitate, robust, streamline, cutting-edge, innovative, transformative, holistic, synergy, methodology, framework (unless named), ecosystem, bandwidth, deep dive, unpack, delve, realm, testament, underscores, pivotal, nuanced, foster.

Structure with these markdown headers:

## WHAT GOT DONE
Completed tasks, meetings held that mattered, visible wins. If it's a quiet week, say so.

## WHAT SLIPPED
Overdue tasks, commitments missed, things sitting too long. Honest about the size of the problem. If nothing slipped, say so.

## RELATIONSHIPS
Who David talked to a lot this week. Who went quiet. Inbound vs outbound patterns — did he send but not receive (cold shoulder) or receive but not send (falling behind).

## DECISIONS
Decisions captured from meetings this week. If none, skip the section entirely.

## COMING UP
Next week's calendar and deadlines. Flag any especially heavy days, client meetings, or prep-required events.

End with one line: what SAM recommends he focus on first Monday morning.

Never invent. If data is missing, say "no data available for X."`;

  const userPrompt = `Week: ${sections.weekLabel}

=== EMAILS THIS WEEK ===
${sections.emails}

=== CALENDAR — PAST 7 DAYS ===
${sections.past}

=== CALENDAR — NEXT 7 DAYS ===
${sections.next}

=== TASKS ===
${sections.tasks}

=== DECISIONS CAPTURED ===
${sections.decisions}

Write the weekly review.`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-opus-4-5",
      max_tokens: 3000,
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
// EMAIL DELIVERY
// ============================================================

async function sendReviewEmail(markdownBody: string, weekLabel: string) {
  const apiKey = Netlify.env.get("RESEND_API_KEY");
  if (!apiKey) throw new Error("RESEND_API_KEY not configured");

  const html = markdownToHtml(markdownBody);
  const wrapped = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>SAM Weekly Review — ${weekLabel}</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 720px; margin: 0 auto; padding: 24px; color: #1a1a1a; line-height: 1.6;">
  <div style="border-bottom: 2px solid #7c3aed; padding-bottom: 14px; margin-bottom: 24px;">
    <div style="font-size: 12px; color: #6b7280; letter-spacing: 1px; text-transform: uppercase;">SAM — Chief of Staff</div>
    <h1 style="font-size: 22px; margin: 6px 0 0 0; color: #111827;">Weekly Review · ${weekLabel}</h1>
  </div>
  ${html}
  <div style="margin-top: 36px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 11px; color: #6b7280;">
    Generated by SAM. Archived at <a href="https://sam-chief-of-staff.netlify.app" style="color: #7c3aed;">sam-chief-of-staff.netlify.app</a>.
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
      from: `SAM <${REVIEW_FROM}>`,
      to: [OWNER_EMAIL],
      subject: `📊 Weekly Review — ${weekLabel}`,
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
      out.push(`<h2 style="font-size:15px;font-weight:700;margin:24px 0 10px;color:#7c3aed;text-transform:uppercase;letter-spacing:0.5px;">${escapeHtml(line.slice(3))}</h2>`);
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
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ============================================================
// ORCHESTRATOR
// ============================================================

export async function buildAndSendReview(): Promise<{
  ok: true;
  key: string;
  preview: string;
  durationMs: number;
}> {
  const start = new Date();
  const weekKey = start.toLocaleDateString("en-CA", { timeZone: TZ });
  const weekLabel = `Week ending ${start.toLocaleDateString("en-US", {
    timeZone: TZ,
    month: "long",
    day: "numeric",
    year: "numeric",
  })}`;

  const [emails, past, next, tasks, decisions] = await Promise.all([
    fetchWeekEmails(),
    fetchWeekCalendar("past"),
    fetchWeekCalendar("next"),
    fetchWeekTasks(),
    fetchWeekDecisions(),
  ]);

  const review = await synthesizeReview({
    emails,
    past,
    next,
    tasks,
    decisions,
    weekLabel,
  });

  await sendReviewEmail(review, weekLabel);

  const store = getStore({ name: "sam-reviews", consistency: "strong" });
  await store.setJSON(weekKey, {
    weekKey,
    weekLabel,
    generatedAt: start.toISOString(),
    review,
    sources: { emails, past, next, tasks, decisions },
  });

  return {
    ok: true,
    key: weekKey,
    preview: review.slice(0, 300),
    durationMs: Date.now() - start.getTime(),
  };
}
