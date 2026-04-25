/**
 * SAM TOOL REGISTRY — declarative capability layer
 *
 * Each tool here is something SAM can actually DO. The Claude branch in ai.mts
 * passes this entire array as `tools` to the Anthropic API; when Claude returns
 * a tool_use block, we look up the tool by name and execute it against the
 * matching internal endpoint.
 *
 * Adding a new capability later is now just adding an entry here. No prompt
 * engineering, no system prompt rewrites. The tool description teaches Claude
 * what it can do.
 *
 * Anti-fabrication: if a tool's execution returns an error, that error is
 * surfaced verbatim to Claude on the next turn. SAM cannot pretend it
 * succeeded — Claude reads the actual tool result and reports honestly.
 */

import { getStore } from "@netlify/blobs";
import { embedText, topKSimilar, type TurnEmbedding } from "./embeddings.ts";
import type { Knowledge } from "./memory-extract.ts";

export interface ToolContext {
  siteOrigin: string;     // e.g. "https://sam-chief-of-staff.netlify.app"
  authHeader?: string;    // forwarded auth if request had any (gives tools the same access the user had)
}

export interface SamTool {
  name: string;
  description: string;
  input_schema: any;  // Anthropic tool schema (JSON Schema)
  execute: (params: any, ctx: ToolContext) => Promise<any>;
}

// ─────────────────────────────────────────────────────────────────────────
// Helper: call an internal SAM endpoint, return the parsed JSON or an error
// ─────────────────────────────────────────────────────────────────────────
async function callInternal(
  ctx: ToolContext,
  path: string,
  init?: RequestInit
): Promise<any> {
  const url = `${ctx.siteOrigin}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "SAM-Tool-Caller",
  };
  if (init?.headers) Object.assign(headers, init.headers);

  try {
    const r = await fetch(url, { ...init, headers });
    const text = await r.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    if (!r.ok) {
      return { error: `HTTP ${r.status}: ${parsed?.error || text.substring(0, 200)}`, status: r.status };
    }
    return parsed;
  } catch (e: any) {
    return { error: e?.message || String(e) };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// TOOLS
// ─────────────────────────────────────────────────────────────────────────

export const SAM_TOOLS: SamTool[] = [

  // ── TIME / GROUNDING ──
  {
    name: "get_current_time",
    description: "Get the current date and time. Use this whenever scheduling something or interpreting a relative time reference like 'tomorrow' or 'next Tuesday' to make sure you're working from the actual current moment, not a guess.",
    input_schema: {
      type: "object",
      properties: {
        timezone: { type: "string", description: "IANA timezone (default: America/New_York)" },
      },
    },
    execute: async (params) => {
      const tz = params?.timezone || "America/New_York";
      const now = new Date();
      return {
        iso: now.toISOString(),
        local: now.toLocaleString("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "long" }),
        timezone: tz,
        timestamp: now.getTime(),
      };
    },
  },

  // ── TASKS ──
  {
    name: "create_task",
    description: "Create a new task in SAM's task system. Use this when David asks to add/track/remember a to-do item.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Task title (short, action-oriented)" },
        priority: { type: "string", enum: ["urgent", "high", "medium", "low"], description: "Priority level (default: medium)" },
        dueDate: { type: "string", description: "Due date in YYYY-MM-DD format (optional)" },
        category: { type: "string", description: "Category like 'follow-up', 'review', 'admin' (optional)" },
        notes: { type: "string", description: "Longer notes about the task (optional)" },
      },
      required: ["title"],
    },
    execute: async (params, ctx) => {
      return await callInternal(ctx, "/api/tasks/", {
        method: "POST",
        body: JSON.stringify({
          title: params.title,
          priority: params.priority || "medium",
          dueDate: params.dueDate,
          category: params.category,
          notes: params.notes,
          status: "todo",
        }),
      });
    },
  },

  {
    name: "list_tasks",
    description: "List all tasks. Filter optionally by status (todo, in-progress, review, done) or priority. Use this before suggesting actions on existing tasks.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter to a single status (optional)" },
        priority: { type: "string", description: "Filter to a single priority (optional)" },
      },
    },
    execute: async (params, ctx) => {
      const result = await callInternal(ctx, "/api/tasks/");
      if (result?.error) return result;
      let tasks = Array.isArray(result?.tasks) ? result.tasks : (Array.isArray(result) ? result : []);
      if (params?.status) tasks = tasks.filter((t: any) => t.status === params.status);
      if (params?.priority) tasks = tasks.filter((t: any) => t.priority === params.priority);
      return { count: tasks.length, tasks };
    },
  },

  {
    name: "update_task",
    description: "Update an existing task's fields. Common uses: mark complete (status='done'), change priority, change due date, edit notes.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task ID" },
        title: { type: "string" },
        status: { type: "string", enum: ["todo", "in-progress", "review", "done"] },
        priority: { type: "string", enum: ["urgent", "high", "medium", "low"] },
        dueDate: { type: "string" },
        notes: { type: "string" },
      },
      required: ["id"],
    },
    execute: async (params, ctx) => {
      const { id, ...updates } = params;
      return await callInternal(ctx, `/api/tasks/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(updates),
      });
    },
  },

  {
    name: "delete_task",
    description: "Permanently delete a task. Use only when David explicitly says to delete or when junk-pruning test entries.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    execute: async (params, ctx) => {
      return await callInternal(ctx, `/api/tasks/${encodeURIComponent(params.id)}`, {
        method: "DELETE",
      });
    },
  },

  // ── ZOOM ──
  {
    name: "create_zoom_meeting",
    description: "Create a Zoom meeting. Returns the join URL which you can include in the email/calendar invite.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Meeting topic/title" },
        startTime: { type: "string", description: "Start time in ISO 8601 format (e.g. 2026-04-29T14:00:00)" },
        durationMinutes: { type: "number", description: "Duration in minutes (default: 30)" },
        agenda: { type: "string", description: "Meeting agenda (optional)" },
        attendees: { type: "array", items: { type: "string" }, description: "Attendee email addresses (optional)" },
      },
      required: ["topic", "startTime"],
    },
    execute: async (params, ctx) => {
      return await callInternal(ctx, "/api/zoom/meetings", {
        method: "POST",
        body: JSON.stringify({
          topic: params.topic,
          start_time: params.startTime,
          duration: params.durationMinutes || 30,
          agenda: params.agenda,
          attendees: params.attendees,
        }),
      });
    },
  },

  // ── CALENDAR ──
  {
    name: "create_calendar_event",
    description: "Create a calendar event in either M365 (admin@edupolicy.ai) or Google (dh30111@gmail.com). Use M365 for client/professional events, Google for personal.",
    input_schema: {
      type: "object",
      properties: {
        calendar: { type: "string", enum: ["m365", "google"], description: "Which calendar to create on" },
        subject: { type: "string", description: "Event title" },
        startTime: { type: "string", description: "Start in ISO 8601 (e.g. 2026-04-29T14:00:00)" },
        endTime: { type: "string", description: "End in ISO 8601" },
        location: { type: "string", description: "Physical location or meeting URL (optional)" },
        attendees: { type: "array", items: { type: "string" }, description: "Attendee emails (optional)" },
        body: { type: "string", description: "Event description/body (optional)" },
      },
      required: ["calendar", "subject", "startTime", "endTime"],
    },
    execute: async (params, ctx) => {
      const path = params.calendar === "google" ? "/api/gcal/event" : "/api/m365/calendar";
      return await callInternal(ctx, path, {
        method: "POST",
        body: JSON.stringify({
          subject: params.subject,
          start: params.startTime,
          end: params.endTime,
          location: params.location,
          attendees: params.attendees,
          body: params.body,
        }),
      });
    },
  },

  {
    name: "get_calendar_events",
    description: "Get calendar events between two timestamps. Combine BOTH calendars (M365 + Google) for a unified view.",
    input_schema: {
      type: "object",
      properties: {
        startTime: { type: "string", description: "Window start ISO 8601" },
        endTime: { type: "string", description: "Window end ISO 8601" },
        calendar: { type: "string", enum: ["m365", "google", "both"], description: "Which calendar(s) — default: both" },
      },
      required: ["startTime", "endTime"],
    },
    execute: async (params, ctx) => {
      const which = params.calendar || "both";
      const qs = `start=${encodeURIComponent(params.startTime)}&end=${encodeURIComponent(params.endTime)}`;
      const [m365, google] = await Promise.all([
        which === "google" ? Promise.resolve({ value: [] }) : callInternal(ctx, `/api/m365/calendar?${qs}`),
        which === "m365" ? Promise.resolve({ value: [] }) : callInternal(ctx, `/api/gcal/events?${qs}`),
      ]);
      return {
        m365: Array.isArray(m365?.value) ? m365.value : [],
        google: Array.isArray(google?.value) ? google.value : [],
      };
    },
  },

  // ── EMAIL ──
  {
    name: "send_email",
    description: "Send an email. Use 'resend' for any @edupolicy.ai sending (most reliable, dhatami@edupolicy.ai etc), 'm365' for admin@edupolicy.ai with calendar integration, 'gmail' for dh30111@gmail.com personal.",
    input_schema: {
      type: "object",
      properties: {
        account: { type: "string", enum: ["resend", "m365", "gmail"], description: "Which sending account" },
        to: { type: "array", items: { type: "string" }, description: "Recipient email(s)" },
        subject: { type: "string" },
        body: { type: "string", description: "Email body (plain text)" },
        cc: { type: "array", items: { type: "string" } },
        bcc: { type: "array", items: { type: "string" } },
        from: { type: "string", description: "From address (only for resend; must end in @edupolicy.ai)" },
      },
      required: ["account", "to", "subject", "body"],
    },
    execute: async (params, ctx) => {
      const path = params.account === "m365"
        ? "/api/m365/mail/send"
        : params.account === "gmail"
          ? "/api/gmail/mail/send"
          : "/api/resend-send";
      const bodyPayload: any = {
        to: params.to,
        subject: params.subject,
        content: params.body,
      };
      if (params.cc) bodyPayload.cc = params.cc;
      if (params.bcc) bodyPayload.bcc = params.bcc;
      if (params.account === "resend" && params.from) bodyPayload.from = params.from;
      return await callInternal(ctx, path, {
        method: "POST",
        body: JSON.stringify(bodyPayload),
      });
    },
  },

  {
    name: "get_recent_emails",
    description: "Pull recent emails from one of David's accounts. Use this before sending follow-ups or referencing prior conversations.",
    input_schema: {
      type: "object",
      properties: {
        account: { type: "string", enum: ["m365", "gmail", "yahoo"], description: "Which inbox" },
        folder: { type: "string", description: "Folder (inbox, sent, etc.) — default: inbox" },
        top: { type: "number", description: "Max messages to return — default: 10, max 50" },
      },
      required: ["account"],
    },
    execute: async (params, ctx) => {
      const folder = params.folder || "inbox";
      const top = Math.min(params.top || 10, 50);
      const path = params.account === "yahoo"
        ? `/api/yahoo-fast/mail?folder=${folder}&top=${top}`
        : `/api/${params.account}/mail?folder=${folder}&top=${top}`;
      const result = await callInternal(ctx, path);
      if (result?.error) return result;
      const value = Array.isArray(result?.value) ? result.value : [];
      // Strip down to the fields a model actually needs
      return {
        count: value.length,
        messages: value.map((m: any) => ({
          id: m.id,
          subject: m.subject,
          from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || "?",
          fromAddress: m.from?.emailAddress?.address,
          receivedAt: m.receivedDateTime,
          isRead: m.isRead,
          preview: (m.bodyPreview || "").substring(0, 200),
        })),
      };
    },
  },

  // ── PROACTIVE OPS ──
  {
    name: "trigger_briefing_now",
    description: "Build and send David's morning briefing right now (without waiting for the 10 UTC cron). Returns the briefing key + summary.",
    input_schema: { type: "object", properties: {} },
    execute: async (_params, ctx) => {
      return await callInternal(ctx, "/api/briefing/now", { method: "POST" });
    },
  },

  {
    name: "trigger_triage_now",
    description: "Run the email triage agent right now. Classifies new mail, drafts replies for the urgent ones.",
    input_schema: { type: "object", properties: {} },
    execute: async (_params, ctx) => {
      return await callInternal(ctx, "/api/triage/run", { method: "POST" });
    },
  },

  {
    name: "trigger_conflict_hunt",
    description: "Scan David's calendar for the next 14 days for overlaps, tight gaps, and focus-block violations.",
    input_schema: { type: "object", properties: {} },
    execute: async (_params, ctx) => {
      return await callInternal(ctx, "/api/conflicts/run", { method: "POST" });
    },
  },

  // ── KNOWLEDGE / MEMORY ──
  {
    name: "search_chat_history",
    description: "Semantic search over past chat conversations. Use this when David asks 'what did we talk about regarding X' or to find context that isn't in standing knowledge.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for" },
        topK: { type: "number", description: "Max results — default 5, max 15" },
      },
      required: ["query"],
    },
    execute: async (params, _ctx) => {
      const openaiKey = Netlify.env.get("OPENAI_API_KEY");
      if (!openaiKey) return { error: "Embeddings require OPENAI_API_KEY" };
      const queryVec = await embedText(params.query, openaiKey);
      if (!queryVec) return { error: "Embedding the query failed" };
      try {
        const histStore = getStore({ name: "sam-chat-history", consistency: "strong" });
        const embStore = getStore({ name: "sam-embeddings", consistency: "strong" });
        const turns = ((await histStore.get("turns", { type: "json" })) as any[]) || [];
        const vectors = ((await embStore.get("vectors", { type: "json" })) as TurnEmbedding[]) || [];
        const matches = topKSimilar(queryVec, vectors, Math.min(params.topK || 5, 15), 0.25);
        const results = matches
          .map((m) => {
            const userIdx = turns.findIndex((t: any) => t.at === m.at && t.role === "user");
            if (userIdx === -1) return null;
            const userTurn = turns[userIdx];
            const assistantTurn = turns[userIdx + 1];
            return {
              when: userTurn.at,
              similarity: Number(m.score.toFixed(3)),
              userSaid: userTurn.content,
              samReplied: assistantTurn?.content || null,
            };
          })
          .filter(Boolean);
        return { count: results.length, results };
      } catch (e: any) {
        return { error: e?.message || String(e) };
      }
    },
  },

  {
    name: "add_to_knowledge",
    description: "Add a durable fact to SAM's standing knowledge. Use this for things David says that should be remembered permanently — preferences, person facts, project updates, decisions made.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["person", "project", "preference", "decision"], description: "Which knowledge bucket" },
        // For person/project:
        name: { type: "string", description: "Person name or project name (for person/project)" },
        fact: { type: "string", description: "The fact to add (for person/project)" },
        status: { type: "string", description: "Project status (for project only)" },
        // For preference/decision:
        text: { type: "string", description: "The preference statement or decision text (for preference/decision)" },
        context: { type: "string", description: "Why/context (for decision)" },
      },
      required: ["category"],
    },
    execute: async (params) => {
      const knowStore = getStore({ name: "sam-knowledge", consistency: "strong" });
      const existing = ((await knowStore.get("knowledge", { type: "json" })) as Knowledge | null) || {
        people: [], projects: [], preferences: [], decisions: [], totalExtractions: 0,
      };
      const now = new Date().toISOString();
      switch (params.category) {
        case "person": {
          if (!params.name || !params.fact) return { error: "person requires name and fact" };
          const found = existing.people.find((p) => p.name.toLowerCase() === params.name.toLowerCase());
          if (found) {
            if (!found.facts.some((f) => f.toLowerCase() === params.fact.toLowerCase())) {
              found.facts.push(params.fact);
            }
            found.lastMentionedAt = now;
          } else {
            existing.people.push({ name: params.name, facts: [params.fact], lastMentionedAt: now });
          }
          break;
        }
        case "project": {
          if (!params.name || !params.fact) return { error: "project requires name and fact" };
          const found = existing.projects.find((p) => p.name.toLowerCase() === params.name.toLowerCase());
          if (found) {
            if (!found.facts.some((f) => f.toLowerCase() === params.fact.toLowerCase())) {
              found.facts.push(params.fact);
            }
            if (params.status) found.status = params.status;
            found.lastUpdatedAt = now;
          } else {
            existing.projects.push({ name: params.name, status: params.status, facts: [params.fact], lastUpdatedAt: now });
          }
          break;
        }
        case "preference": {
          if (!params.text) return { error: "preference requires text" };
          if (!existing.preferences.some((p) => p.text.toLowerCase() === params.text.toLowerCase())) {
            existing.preferences.push({ text: params.text, extractedAt: now });
          }
          break;
        }
        case "decision": {
          if (!params.text) return { error: "decision requires text" };
          if (!existing.decisions.some((d) => d.text.toLowerCase() === params.text.toLowerCase())) {
            existing.decisions.push({ text: params.text, context: params.context, decidedAt: now });
          }
          break;
        }
        default:
          return { error: `Unknown category: ${params.category}` };
      }
      await knowStore.setJSON("knowledge", existing);
      return { ok: true, totals: {
        people: existing.people.length,
        projects: existing.projects.length,
        preferences: existing.preferences.length,
        decisions: existing.decisions.length,
      }};
    },
  },
];

// Anthropic-formatted tool definitions for the messages API
export function getAnthropicTools() {
  return SAM_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

export async function executeTool(name: string, params: any, ctx: ToolContext): Promise<any> {
  const tool = SAM_TOOLS.find((t) => t.name === name);
  if (!tool) return { error: `Unknown tool: ${name}` };
  try {
    const result = await tool.execute(params, ctx);
    return result;
  } catch (e: any) {
    return { error: e?.message || String(e) };
  }
}
