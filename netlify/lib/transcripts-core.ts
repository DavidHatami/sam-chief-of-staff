import { getStore } from "@netlify/blobs";

/**
 * SAM PHASE 1.4 — TRANSCRIPT-TO-TASKS ENHANCEMENT
 *
 * The existing zoom-check-background.mts already extracts action items
 * from Zoom transcripts every 15 minutes. This enhancement adds:
 *
 *   1. On-demand extraction endpoint — re-process a specific recording
 *      (useful when the automated pass produced poor results or David
 *      wants to re-run with different settings).
 *
 *   2. Decisions log — separate store for decisions made in meetings.
 *      The original cron captured them but threw them away. Now they
 *      persist in sam-decisions, queryable by date and topic.
 *
 *   3. Meeting summary blob — each processed meeting leaves behind a
 *      summary record in sam-meeting-summaries so the briefing engine
 *      and future client-context pages can surface them.
 *
 *   4. Auto-project tagging — when a meeting topic matches a known
 *      project name in sam-projects, created tasks get auto-tagged.
 *
 * Blob stores touched:
 *   sam-tasks              — existing. New tasks written here.
 *   sam-meeting-summaries  — new. <recordingId> → summary record
 *   sam-decisions          — new. <decisionId>  → decision record
 *   sam-projects           — existing. Read-only for auto-tagging.
 */

// ============================================================
// AUTH
// ============================================================

async function getZoomToken(): Promise<string | null> {
  const accountId = Netlify.env.get("ZOOM_ACCOUNT_ID");
  const clientId = Netlify.env.get("ZOOM_CLIENT_ID");
  const clientSecret = Netlify.env.get("ZOOM_CLIENT_SECRET");
  if (!accountId || !clientId || !clientSecret) return null;

  const auth = btoa(`${clientId}:${clientSecret}`);
  const resp = await fetch("https://zoom.us/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "account_credentials", account_id: accountId }),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.access_token;
}

// ============================================================
// EXTRACTION — Claude returns structured JSON
// ============================================================

interface ExtractionResult {
  summary: string;
  action_items: {
    task: string;
    owner: string;
    deadline: string | null;
    priority: "urgent" | "high" | "normal" | "low";
  }[];
  decisions: string[];
  follow_ups: string[];
  detected_project: string | null;
}

const EXTRACTION_SYSTEM = `You extract structured information from meeting transcripts. Return ONLY valid JSON — no markdown fences, no preamble, no commentary.

Schema:
{
  "summary": "3-sentence summary of what was discussed and agreed",
  "action_items": [{"task":"specific action","owner":"person name or Unknown","deadline":"YYYY-MM-DD or ASAP or null","priority":"urgent|high|normal|low"}],
  "decisions": ["decision that was made"],
  "follow_ups": ["item needing follow-up"],
  "detected_project": "project or client name if clearly mentioned, else null"
}

Rules:
- Only include action items that are genuine commitments. Not speculation, not "we should maybe."
- Owner "David" or "Dr. Hatami" means David Hatami (owner of the account).
- If the transcript is short/unclear, return empty arrays rather than invent items.
- Priority: urgent = must happen in 24-48h, high = this week, normal = this month, low = someday.`;

async function extractFromTranscript(args: {
  topic: string;
  date: string;
  duration: number;
  transcript: string;
}): Promise<ExtractionResult> {
  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing");

  const userPrompt = `Meeting: ${args.topic}
Date: ${args.date}
Duration: ${args.duration} minutes

Transcript (first 8000 chars):
${args.transcript.substring(0, 8000)}`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-opus-4-5",
      max_tokens: 2000,
      system: EXTRACTION_SYSTEM,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!resp.ok) throw new Error(`Claude extraction failed: ${resp.status} ${await resp.text()}`);

  const data = await resp.json();
  try {
    const { trackCost } = await import("./llm-cost.ts");
    await trackCost({
      provider: "anthropic",
      model: "claude-opus-4-5",
      feature: "transcripts_to_tasks",
      responseBody: data,
    });
  } catch {}
  const text = data.content?.[0]?.text || "{}";
  const clean = text.replace(/```json|```/g, "").trim();
  try {
    const parsed = JSON.parse(clean);
    return {
      summary: parsed.summary || "",
      action_items: Array.isArray(parsed.action_items) ? parsed.action_items : [],
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
      follow_ups: Array.isArray(parsed.follow_ups) ? parsed.follow_ups : [],
      detected_project: parsed.detected_project || null,
    };
  } catch {
    return { summary: "", action_items: [], decisions: [], follow_ups: [], detected_project: null };
  }
}

// ============================================================
// PROJECT AUTO-TAGGING
// ============================================================

async function resolveProjectTag(detected: string | null): Promise<string | null> {
  if (!detected) return null;
  try {
    const store = getStore({ name: "sam-projects", consistency: "strong" });
    const { blobs } = await store.list();
    const projects = await Promise.all(
      blobs.map((b: any) => store.get(b.key, { type: "json" }).catch(() => null))
    );
    const needle = detected.toLowerCase();
    for (const p of projects) {
      if (!p) continue;
      const name = (p.name || p.title || "").toLowerCase();
      if (name && (name.includes(needle) || needle.includes(name))) {
        return p.name || p.title;
      }
    }
    return detected; // fall back to raw detected string
  } catch {
    return detected;
  }
}

// ============================================================
// PERSISTENCE
// ============================================================

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

async function persistExtraction(args: {
  recordingId: string;
  topic: string;
  meetingDate: string;
  extraction: ExtractionResult;
}): Promise<{ tasksCreated: number; decisionsLogged: number }> {
  const { recordingId, topic, meetingDate, extraction } = args;
  const projectTag = await resolveProjectTag(extraction.detected_project);

  // 1. Meeting summary
  const summaryStore = getStore({ name: "sam-meeting-summaries", consistency: "strong" });
  await summaryStore.setJSON(recordingId, {
    recordingId,
    topic,
    meetingDate,
    summary: extraction.summary,
    actionItemCount: extraction.action_items.length,
    decisionCount: extraction.decisions.length,
    followUpCount: extraction.follow_ups.length,
    projectTag,
    processedAt: new Date().toISOString(),
  });

  // 2. Tasks
  const taskStore = getStore({ name: "sam-tasks", consistency: "strong" });
  let tasksCreated = 0;
  for (const ai of extraction.action_items) {
    const id = genId();
    const nowIso = new Date().toISOString();
    const task = {
      id,
      title: ai.task,
      description: `From meeting: ${topic} (${meetingDate}). Owner: ${ai.owner}.`,
      priority: ai.priority || "normal",
      status: "review", // user approves before it enters active queue
      category: "Zoom Auto-Extract",
      dueDate: normalizeDeadline(ai.deadline),
      notes: projectTag ? `Project: ${projectTag}` : "",
      project: projectTag || undefined,
      sourceRecordingId: recordingId,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await taskStore.setJSON(id, task);
    tasksCreated++;
  }

  // 3. Decisions log
  const decisionStore = getStore({ name: "sam-decisions", consistency: "strong" });
  let decisionsLogged = 0;
  for (const d of extraction.decisions) {
    const id = genId();
    await decisionStore.setJSON(id, {
      id,
      decision: d,
      source: "zoom_meeting",
      sourceRecordingId: recordingId,
      sourceMeetingTopic: topic,
      meetingDate,
      projectTag,
      loggedAt: new Date().toISOString(),
    });
    decisionsLogged++;
  }

  return { tasksCreated, decisionsLogged };
}

function normalizeDeadline(d: string | null): string | undefined {
  if (!d || d === "null") return undefined;
  if (d === "ASAP") {
    // 2 days out
    const dt = new Date(Date.now() + 2 * 24 * 3600 * 1000);
    return dt.toISOString().split("T")[0];
  }
  // Accept YYYY-MM-DD already
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  // Try to parse anything else
  const t = new Date(d);
  if (!isNaN(t.getTime())) return t.toISOString().split("T")[0];
  return undefined;
}

// ============================================================
// ON-DEMAND REPROCESSING
// ============================================================

export async function reprocessRecording(recordingId: string): Promise<{
  ok: boolean;
  tasksCreated: number;
  decisionsLogged: number;
  summary: string;
  error?: string;
}> {
  const token = await getZoomToken();
  if (!token) return { ok: false, tasksCreated: 0, decisionsLogged: 0, summary: "", error: "Zoom auth failed" };

  // Fetch recording detail
  const detailResp = await fetch(
    `https://api.zoom.us/v2/meetings/${recordingId}/recordings`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!detailResp.ok) {
    return { ok: false, tasksCreated: 0, decisionsLogged: 0, summary: "", error: `Zoom API ${detailResp.status}` };
  }
  const detail = await detailResp.json();
  const transcriptFile = (detail.recording_files || []).find(
    (f: any) =>
      f.file_type === "TRANSCRIPT" ||
      f.recording_type === "audio_transcript" ||
      f.file_extension === "VTT"
  );
  if (!transcriptFile?.download_url) {
    return { ok: false, tasksCreated: 0, decisionsLogged: 0, summary: "", error: "No transcript available for this recording" };
  }

  const vttResp = await fetch(`${transcriptFile.download_url}?access_token=${token}`);
  if (!vttResp.ok) {
    return { ok: false, tasksCreated: 0, decisionsLogged: 0, summary: "", error: "Transcript download failed" };
  }
  const vtt = await vttResp.text();

  // Strip VTT formatting → plain text
  const plain = vtt
    .replace(/WEBVTT.*?\n/g, "")
    .replace(/\d{2}:\d{2}:\d{2}\.\d+\s-->\s\d{2}:\d{2}:\d{2}\.\d+/g, "")
    .replace(/^\d+\n/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const extraction = await extractFromTranscript({
    topic: detail.topic || "Meeting",
    date: detail.start_time || new Date().toISOString(),
    duration: detail.duration || 0,
    transcript: plain,
  });

  const persist = await persistExtraction({
    recordingId,
    topic: detail.topic || "Meeting",
    meetingDate: detail.start_time || new Date().toISOString(),
    extraction,
  });

  return {
    ok: true,
    tasksCreated: persist.tasksCreated,
    decisionsLogged: persist.decisionsLogged,
    summary: extraction.summary,
  };
}

// ============================================================
// QUERY HELPERS
// ============================================================

export async function listMeetingSummaries(limit: number = 20): Promise<any[]> {
  const store = getStore({ name: "sam-meeting-summaries", consistency: "strong" });
  const { blobs } = await store.list();
  const all = await Promise.all(
    blobs.slice(0, 100).map((b: any) => store.get(b.key, { type: "json" }).catch(() => null))
  );
  return (all.filter(Boolean) as any[])
    .sort((a, b) => (b.meetingDate || "").localeCompare(a.meetingDate || ""))
    .slice(0, limit);
}

export async function listDecisions(limit: number = 50, projectFilter?: string): Promise<any[]> {
  const store = getStore({ name: "sam-decisions", consistency: "strong" });
  const { blobs } = await store.list();
  const all = await Promise.all(
    blobs.map((b: any) => store.get(b.key, { type: "json" }).catch(() => null))
  );
  let filtered = (all.filter(Boolean) as any[]);
  if (projectFilter) {
    const p = projectFilter.toLowerCase();
    filtered = filtered.filter((d) => (d.projectTag || "").toLowerCase().includes(p));
  }
  return filtered
    .sort((a, b) => (b.loggedAt || "").localeCompare(a.loggedAt || ""))
    .slice(0, limit);
}
