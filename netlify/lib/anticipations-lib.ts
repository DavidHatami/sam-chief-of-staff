/**
 * SAM ANTICIPATIONS — proactive morning intelligence pass
 *
 * Once a day (after the briefing) we run a synthesis pass over David's
 * calendar, tasks, inbox, and standing knowledge. The output is a small set
 * of actionable nudges — things SAM thinks David should KNOW or DO today.
 *
 * Examples of what good anticipations look like:
 *   - "Your 2pm meeting with Janet is in 4 hours. Standing notes show this
 *      is the AI policy training engagement; want me to draft talking points?"
 *   - "Patricia hasn't replied to your March 12 email in 24 days; want me
 *      to draft a follow-up?"
 *   - "Step Up invoice approval task has been overdue since April 15.
 *      Last action was sending it to admin@stepup.org."
 *
 * Stored in the sam-anticipations blob keyed by date. Frontend dashboard
 * card surfaces the latest set; user can dismiss individual items.
 */

import { getStore } from "@netlify/blobs";
import type { Knowledge } from "./memory-extract.ts";

export interface Anticipation {
  id: string;
  title: string;          // The nudge/suggestion (one-liner)
  reason: string;         // Why SAM thinks this is worth surfacing
  priority: "high" | "medium" | "low";
  category: "meeting" | "email" | "task" | "deadline" | "follow-up" | "insight";
  suggestedAction?: string;  // What SAM could do about it (often a tool name)
  relatedItem?: any;      // Original calendar/task/email reference
  generatedAt: string;
  dismissed?: boolean;
  dismissedAt?: string;
}

export interface AnticipationSet {
  forDate: string;        // YYYY-MM-DD
  generatedAt: string;
  anticipations: Anticipation[];
}

/**
 * Build the anticipations for today by calling Claude over David's current
 * state. We give the model real data — calendar, tasks, inbox snapshot,
 * standing knowledge — and ask it to identify the 3-7 things that warrant
 * David's attention.
 */
export async function buildAnticipations(
  ctx: {
    calendarEvents: any[];      // M365 + Google merged
    tasks: any[];
    unreadEmails: any[];
    triageBuckets: any;          // counts by classification
    knowledge: Knowledge;
    today: string;               // YYYY-MM-DD ET
  },
  anthropicKey: string
): Promise<Anticipation[]> {
  if (!anthropicKey) return [];

  // Render context as compact text the model can reason over
  const eventsText = ctx.calendarEvents.length === 0
    ? "(no events today)"
    : ctx.calendarEvents.slice(0, 12).map((e: any) => {
        const start = e.start?.dateTime || e.start?.date || "?";
        const subject = e.subject || e.summary || "(no title)";
        const attendees = (e.attendees || []).map((a: any) => a.emailAddress?.address || a.email || "").filter(Boolean).slice(0, 5).join(", ");
        return `  • ${subject} @ ${start}${attendees ? ` (${attendees})` : ""}`;
      }).join("\n");

  const tasksText = ctx.tasks.length === 0
    ? "(no active tasks)"
    : ctx.tasks.slice(0, 15).map((t: any) =>
        `  • [${t.priority || "?"}] ${t.title}${t.dueDate ? ` (due ${t.dueDate})` : ""}${t.status ? ` [${t.status}]` : ""}`
      ).join("\n");

  const emailsText = ctx.unreadEmails.length === 0
    ? "(no unread urgent mail)"
    : ctx.unreadEmails.slice(0, 10).map((m: any) =>
        `  • ${m.subject} — from ${m.from?.emailAddress?.name || m.from?.emailAddress?.address || "?"} (${m.receivedDateTime || "?"})`
      ).join("\n");

  const peopleText = ctx.knowledge.people.slice(0, 15).map((p) =>
    `  • ${p.name}: ${p.facts.slice(0, 3).join("; ")}`
  ).join("\n") || "(no people on file)";

  const projectsText = ctx.knowledge.projects.slice(0, 10).map((p) =>
    `  • ${p.name}${p.status ? ` (${p.status})` : ""}: ${p.facts.slice(0, 2).join("; ")}`
  ).join("\n") || "(no projects on file)";

  const prompt = `You are SAM in proactive-mode. It's the start of David's day (${ctx.today}). Your job: identify the 3-7 things he should pay attention to today, ranked by what would matter most if he missed them.

DAVID'S CALENDAR TODAY:
${eventsText}

ACTIVE TASKS (top 15):
${tasksText}

UNREAD URGENT EMAILS (top 10):
${emailsText}

PEOPLE ON FILE:
${peopleText}

PROJECTS:
${projectsText}

TRIAGE BUCKETS:
${JSON.stringify(ctx.triageBuckets || {})}

Return a JSON array of 3-7 anticipation objects. Each must have:
  - title: a short specific nudge ("Your 2pm with Janet is in 4 hours")
  - reason: why this matters today (specific, evidence-grounded)
  - priority: "high" | "medium" | "low"
  - category: "meeting" | "email" | "task" | "deadline" | "follow-up" | "insight"
  - suggestedAction: optional, what tool SAM could call (e.g. "Draft talking points via send_email" or "Create follow-up task")

RULES:
- Be SPECIFIC. Not "Review your tasks" — instead "Step Up invoice has been overdue 10 days; was last touched April 15."
- CONNECT data points. Calendar event with an attendee whose name is in PEOPLE → reference what we know about them. Email from Patricia + Patricia in PEOPLE = signal.
- SKIP the trivial. Don't surface the routine. Surface what's UNUSUAL, OVERDUE, IMPENDING, or REQUIRES PREP.
- DON'T fabricate. If you don't have enough data to be specific, return fewer items rather than padding.
- Return ONLY a valid JSON array. No markdown fences, no preamble.`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        max_tokens: 2048,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) {
      console.error(`[anticipations] Claude HTTP ${r.status}: ${(await r.text()).substring(0, 200)}`);
      return [];
    }
    const data = await r.json();
    const text = data.content?.map((b: any) => b.type === "text" ? b.text : "").join("") || "";
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    const arr = JSON.parse(cleaned);
    if (!Array.isArray(arr)) return [];
    const now = new Date().toISOString();
    return arr.slice(0, 7).map((a: any, idx: number) => ({
      id: `anticip_${ctx.today}_${idx}_${Date.now()}`,
      title: String(a.title || "").substring(0, 200),
      reason: String(a.reason || "").substring(0, 500),
      priority: ["high", "medium", "low"].includes(a.priority) ? a.priority : "medium",
      category: ["meeting", "email", "task", "deadline", "follow-up", "insight"].includes(a.category) ? a.category : "insight",
      suggestedAction: a.suggestedAction ? String(a.suggestedAction).substring(0, 200) : undefined,
      generatedAt: now,
    })).filter((a) => a.title);
  } catch (e: any) {
    console.error(`[anticipations] parse failed: ${e?.message || e}`);
    return [];
  }
}
