import { getStore } from "@netlify/blobs";

/**
 * SAM PHASE 1.3 — CALENDAR CONFLICT HUNTER (shared core)
 *
 * Every 30 minutes: pull the next 14 days of events from M365 calendar.
 * Detect:
 *   (a) hard conflicts — two events overlap in time
 *   (b) tight gaps — less than 15 minutes between back-to-back meetings
 *       (travel time, bathroom, brain reset)
 *   (c) focus-block violations — any event landing during a named
 *       "focus" / "deep work" / "do not book" block
 *
 * For each detected issue, propose three alternative time slots pulled
 * from David's actual free/busy data. Fire a single digest email via
 * Resend to admin@edupolicy.ai when new issues appear. Idempotent —
 * we track already-alerted-on pairs in a blob so we don't spam.
 *
 * BLOB STORE: sam-conflicts
 *   <conflictId>           → { id, type, events, proposedAlternatives,
 *                              detectedAt, notifiedAt, status }
 *   _alerted:<hash>        → ISO timestamp, dedupe marker
 */

const TZ = "America/New_York";
const OWNER_EMAIL = "admin@edupolicy.ai";
const BRIEFING_FROM = "briefing@edupolicy.ai";

const FOCUS_KEYWORDS = ["focus", "deep work", "do not book", "dnb", "blocked", "heads down", "writing time"];
const TIGHT_GAP_MINUTES = 15;
const LOOKAHEAD_DAYS = 14;

export type ConflictType = "overlap" | "tight_gap" | "focus_violation";

export interface CalEvent {
  id: string;
  subject: string;
  start: string; // ISO
  end: string;   // ISO
  location?: string;
  organizer?: string;
  attendees?: string[];
  isFocusBlock: boolean;
}

export interface ConflictRecord {
  id: string;
  type: ConflictType;
  events: CalEvent[];       // the conflicting events (1 for focus, 2 for overlap/gap)
  detail: string;           // human-readable summary
  proposedAlternatives: { start: string; end: string; label: string }[];
  detectedAt: string;
  notifiedAt: string | null;
  status: "new" | "notified" | "resolved" | "dismissed";
}

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
  const data = await resp.json();
  return data.access_token;
}

// ============================================================
// FETCH UPCOMING EVENTS
// ============================================================

async function fetchUpcomingEvents(daysAhead: number): Promise<CalEvent[]> {
  const token = await getM365Token();
  if (!token) return [];
  const userEmail = Netlify.env.get("M365_USER_EMAIL") || "";
  const now = new Date();
  const end = new Date(Date.now() + daysAhead * 24 * 3600 * 1000);
  const url =
    `https://graph.microsoft.com/v1.0/users/${userEmail}/calendarView` +
    `?startDateTime=${now.toISOString()}&endDateTime=${end.toISOString()}` +
    `&$select=id,subject,start,end,location,attendees,organizer` +
    `&$orderby=start/dateTime&$top=200`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Prefer: `outlook.timezone="UTC"` },
  });
  if (!r.ok) return [];
  const d = await r.json();
  return (d.value || []).map((e: any) => {
    const subjectLower = (e.subject || "").toLowerCase();
    const isFocusBlock = FOCUS_KEYWORDS.some((kw) => subjectLower.includes(kw));
    return {
      id: e.id,
      subject: e.subject || "(no subject)",
      start: e.start?.dateTime ? e.start.dateTime + "Z" : "",
      end: e.end?.dateTime ? e.end.dateTime + "Z" : "",
      location: e.location?.displayName || undefined,
      organizer: e.organizer?.emailAddress?.name,
      attendees: (e.attendees || []).map((a: any) => a.emailAddress?.name || a.emailAddress?.address).filter(Boolean),
      isFocusBlock,
    };
  });
}

// ============================================================
// CONFLICT DETECTION
// ============================================================

function detectConflicts(events: CalEvent[]): {
  overlaps: [CalEvent, CalEvent][];
  tightGaps: [CalEvent, CalEvent][];
  focusViolations: [CalEvent, CalEvent][]; // [focusBlock, invader]
} {
  const overlaps: [CalEvent, CalEvent][] = [];
  const tightGaps: [CalEvent, CalEvent][] = [];
  const focusViolations: [CalEvent, CalEvent][] = [];

  // Sorted by start ascending
  const sorted = [...events].sort((a, b) => a.start.localeCompare(b.start));

  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const aStart = new Date(a.start).getTime();
    const aEnd = new Date(a.end).getTime();

    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      const bStart = new Date(b.start).getTime();
      const bEnd = new Date(b.end).getTime();

      // Already past A's window? Stop scanning forward.
      if (bStart > aEnd + TIGHT_GAP_MINUTES * 60 * 1000) break;

      const overlap = bStart < aEnd && bEnd > aStart;
      if (overlap) {
        // Focus violation takes priority over generic overlap
        if (a.isFocusBlock && !b.isFocusBlock) {
          focusViolations.push([a, b]);
        } else if (b.isFocusBlock && !a.isFocusBlock) {
          focusViolations.push([b, a]);
        } else {
          overlaps.push([a, b]);
        }
        continue;
      }

      // Tight gap — b starts within TIGHT_GAP_MINUTES of a ending
      const gapMins = (bStart - aEnd) / 60000;
      if (gapMins >= 0 && gapMins < TIGHT_GAP_MINUTES) {
        // Skip tight-gap alerts where either side is a focus block — those aren't really back-to-back
        if (!a.isFocusBlock && !b.isFocusBlock) {
          tightGaps.push([a, b]);
        }
      }
    }
  }

  return { overlaps, tightGaps, focusViolations };
}

// ============================================================
// ALTERNATIVE SLOT SUGGESTION
// ============================================================

function proposeAlternatives(
  targetEvent: CalEvent,
  allEvents: CalEvent[]
): { start: string; end: string; label: string }[] {
  const durationMs = new Date(targetEvent.end).getTime() - new Date(targetEvent.start).getTime();
  const suggestions: { start: string; end: string; label: string }[] = [];
  const busyRanges = allEvents
    .filter((e) => e.id !== targetEvent.id)
    .map((e) => ({ start: new Date(e.start).getTime(), end: new Date(e.end).getTime() }));

  // Try each of the next 7 weekdays, 9am-5pm ET, 30-min granularity
  for (let dayOffset = 1; dayOffset <= 7 && suggestions.length < 3; dayOffset++) {
    const day = new Date();
    day.setDate(day.getDate() + dayOffset);
    const dow = day.getDay();
    if (dow === 0 || dow === 6) continue; // skip weekends

    // 9am ET = 13:00 UTC (EDT) or 14:00 UTC (EST). We'll use 13:00 UTC baseline.
    // Not perfect across DST edges, but good enough — David can adjust.
    const baseUtc = new Date(
      Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), 13, 0, 0)
    );

    for (let slotMin = 0; slotMin < 8 * 60 && suggestions.length < 3; slotMin += 30) {
      const slotStart = baseUtc.getTime() + slotMin * 60000;
      const slotEnd = slotStart + durationMs;

      const collides = busyRanges.some((r) => slotStart < r.end && slotEnd > r.start);
      if (!collides) {
        suggestions.push({
          start: new Date(slotStart).toISOString(),
          end: new Date(slotEnd).toISOString(),
          label: formatSlotLabel(slotStart, slotEnd),
        });
      }
    }
  }

  return suggestions;
}

function formatSlotLabel(startMs: number, endMs: number): string {
  const s = new Date(startMs);
  const e = new Date(endMs);
  const dayStr = s.toLocaleDateString("en-US", {
    timeZone: TZ, weekday: "short", month: "short", day: "numeric",
  });
  const startT = s.toLocaleTimeString("en-US", {
    timeZone: TZ, hour: "numeric", minute: "2-digit",
  });
  const endT = e.toLocaleTimeString("en-US", {
    timeZone: TZ, hour: "numeric", minute: "2-digit",
  });
  return `${dayStr}, ${startT}–${endT} ET`;
}

// ============================================================
// DEDUP + ALERT
// ============================================================

function conflictHash(type: ConflictType, events: CalEvent[]): string {
  // Stable hash: type + sorted event IDs
  const ids = events.map((e) => e.id).sort().join("|");
  return `${type}:${ids}`;
}

async function sendConflictDigest(records: ConflictRecord[]): Promise<void> {
  if (!records.length) return;
  const apiKey = Netlify.env.get("RESEND_API_KEY");
  if (!apiKey) return;

  const bodyLines: string[] = [];
  bodyLines.push(`<h2 style="color:#2563eb;margin-top:0;">Calendar Alert — ${records.length} issue${records.length > 1 ? "s" : ""} detected</h2>`);
  for (const r of records) {
    bodyLines.push(`<div style="border-left:3px solid #f59e0b;padding:10px 14px;margin:12px 0;background:#fff7ed;border-radius:4px;">`);
    bodyLines.push(`<div style="font-weight:700;font-size:13px;color:#92400e;text-transform:uppercase;letter-spacing:0.5px;">${r.type.replace(/_/g, " ")}</div>`);
    bodyLines.push(`<div style="margin:6px 0;color:#1f2937;">${escapeHtml(r.detail)}</div>`);
    bodyLines.push(`<div style="margin-top:8px;"><strong style="font-size:12px;">Events:</strong>`);
    for (const ev of r.events) {
      const when = new Date(ev.start).toLocaleString("en-US", {
        timeZone: TZ, weekday: "short", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit",
      });
      bodyLines.push(`<div style="font-size:12px;color:#4b5563;margin-left:12px;">• ${when} — ${escapeHtml(ev.subject)}</div>`);
    }
    bodyLines.push(`</div>`);
    if (r.proposedAlternatives.length) {
      bodyLines.push(`<div style="margin-top:8px;"><strong style="font-size:12px;">Alternative slots:</strong>`);
      for (const alt of r.proposedAlternatives) {
        bodyLines.push(`<div style="font-size:12px;color:#059669;margin-left:12px;">→ ${escapeHtml(alt.label)}</div>`);
      }
      bodyLines.push(`</div>`);
    }
    bodyLines.push(`</div>`);
  }

  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:680px;margin:0 auto;padding:20px;color:#111827;line-height:1.5;">
<div style="font-size:11px;color:#6b7280;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">SAM — Calendar Conflict Hunter</div>
${bodyLines.join("")}
<div style="margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb;font-size:11px;color:#6b7280;">Detected at ${new Date().toLocaleString("en-US", { timeZone: TZ })}.</div>
</body></html>`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      from: `SAM <${BRIEFING_FROM}>`,
      to: [OWNER_EMAIL],
      subject: `⚠️ Calendar Alert — ${records.length} issue${records.length > 1 ? "s" : ""}`,
      html,
    }),
  });
}

function escapeHtml(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ============================================================
// MAIN — fetch, detect, store new, notify
// ============================================================

export async function runConflictHunt(): Promise<{
  ok: true;
  totalEvents: number;
  detected: { overlaps: number; tightGaps: number; focusViolations: number };
  newlyRecorded: number;
  notified: number;
  durationMs: number;
}> {
  const start = Date.now();
  const store = getStore({ name: "sam-conflicts", consistency: "strong" });
  const events = await fetchUpcomingEvents(LOOKAHEAD_DAYS);
  const detected = detectConflicts(events);

  const toRecord: ConflictRecord[] = [];

  // OVERLAPS
  for (const [a, b] of detected.overlaps) {
    const hash = conflictHash("overlap", [a, b]);
    const dedup = await store.get(`_alerted:${hash}`, { type: "text" }).catch(() => null);
    if (dedup) continue;
    const alt = proposeAlternatives(b, events); // suggest moving the second event
    toRecord.push({
      id: hash,
      type: "overlap",
      events: [a, b],
      detail: `Two events overlap: "${a.subject}" and "${b.subject}" both run during the same window.`,
      proposedAlternatives: alt,
      detectedAt: new Date().toISOString(),
      notifiedAt: null,
      status: "new",
    });
  }

  // TIGHT GAPS
  for (const [a, b] of detected.tightGaps) {
    const hash = conflictHash("tight_gap", [a, b]);
    const dedup = await store.get(`_alerted:${hash}`, { type: "text" }).catch(() => null);
    if (dedup) continue;
    const gapMins = Math.round(
      (new Date(b.start).getTime() - new Date(a.end).getTime()) / 60000
    );
    toRecord.push({
      id: hash,
      type: "tight_gap",
      events: [a, b],
      detail: `Only ${gapMins} minutes between "${a.subject}" and "${b.subject}". No buffer for travel or reset.`,
      proposedAlternatives: proposeAlternatives(b, events),
      detectedAt: new Date().toISOString(),
      notifiedAt: null,
      status: "new",
    });
  }

  // FOCUS VIOLATIONS
  for (const [focus, invader] of detected.focusViolations) {
    const hash = conflictHash("focus_violation", [focus, invader]);
    const dedup = await store.get(`_alerted:${hash}`, { type: "text" }).catch(() => null);
    if (dedup) continue;
    toRecord.push({
      id: hash,
      type: "focus_violation",
      events: [focus, invader],
      detail: `"${invader.subject}" lands inside your focus block "${focus.subject}".`,
      proposedAlternatives: proposeAlternatives(invader, events),
      detectedAt: new Date().toISOString(),
      notifiedAt: null,
      status: "new",
    });
  }

  // Persist + notify
  let notifiedCount = 0;
  if (toRecord.length) {
    for (const r of toRecord) {
      await store.setJSON(r.id, r);
      await store.set(`_alerted:${conflictHash(r.type, r.events)}`, new Date().toISOString());
    }
    try {
      await sendConflictDigest(toRecord);
      for (const r of toRecord) {
        r.notifiedAt = new Date().toISOString();
        r.status = "notified";
        await store.setJSON(r.id, r);
      }
      notifiedCount = toRecord.length;
    } catch (e: any) {
      console.error("Conflict digest send failed:", e.message);
    }
  }

  return {
    ok: true,
    totalEvents: events.length,
    detected: {
      overlaps: detected.overlaps.length,
      tightGaps: detected.tightGaps.length,
      focusViolations: detected.focusViolations.length,
    },
    newlyRecorded: toRecord.length,
    notified: notifiedCount,
    durationMs: Date.now() - start,
  };
}

export async function listOpenConflicts(): Promise<ConflictRecord[]> {
  const store = getStore({ name: "sam-conflicts", consistency: "strong" });
  const { blobs } = await store.list();
  const recordBlobs = blobs.filter((b: any) => !b.key.startsWith("_alerted:"));
  const all = await Promise.all(
    recordBlobs.map((b: any) => store.get(b.key, { type: "json" }).catch(() => null))
  );
  return (all.filter(Boolean) as ConflictRecord[])
    .filter((c) => c.status !== "resolved" && c.status !== "dismissed")
    .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
}

export async function updateConflictStatus(
  id: string,
  status: "resolved" | "dismissed"
): Promise<boolean> {
  const store = getStore({ name: "sam-conflicts", consistency: "strong" });
  const record = (await store.get(id, { type: "json" })) as ConflictRecord | null;
  if (!record) return false;
  record.status = status;
  await store.setJSON(id, record);
  return true;
}
