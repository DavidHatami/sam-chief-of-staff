import { getStore } from "@netlify/blobs";

/**
 * SAM PHASE 2.2 — CLIENT CONTEXT PAGES
 *
 * One query returns every piece of context SAM has about a named entity:
 *   - emails from or to that domain (both inbound and sent)
 *   - calendar events where they were attendees
 *   - tasks tagged to them
 *   - zoom transcripts with them as participants
 *   - recent decisions captured from meetings
 *   - writing voice: last reply David sent them (seed for tone matching)
 *
 * Takes an entity descriptor — either an email domain ("hccfl.edu") or
 * a display name ("Hillsborough Community College"). Matching is fuzzy
 * by design: David types what comes to mind, SAM figures it out.
 *
 * This is the feature that turns the dashboard into a relationship brain.
 * Before: "What did we decide with them last time?" was a 10-tab dig.
 * After: one URL, one render.
 */

export const TZ = "America/New_York";

export interface ContextBundle {
  entity: string;               // the query as David typed it
  resolvedDomain: string | null;
  resolvedNames: string[];      // display names seen across data
  emails: ContextEmail[];
  events: ContextEvent[];
  tasks: ContextTask[];
  transcripts: ContextTranscript[];
  decisions: ContextDecision[];
  lastReplySent: string | null; // David's most recent reply to them (voice seed)
  relationship: {
    firstSeen: string | null;
    lastContact: string | null;
    totalEmails: number;
    totalMeetings: number;
    unansweredFromThem: number; // emails they sent that David never replied to
  };
  durationMs: number;
}

interface ContextEmail {
  id: string;
  account: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  subject: string;
  preview: string;
  receivedAt: string;
  bucket: string | null;
}

interface ContextEvent {
  id: string;
  subject: string;
  start: string;
  end: string;
  attendees: string[];
  location: string | null;
}

interface ContextTask {
  id: string;
  title: string;
  status: string;
  priority: string | null;
  dueDate: string | null;
  createdAt: string | null;
}

interface ContextTranscript {
  id: string;
  topic: string;
  meetingDate: string;
  excerpt: string;
}

interface ContextDecision {
  id: string;
  decidedAt: string;
  summary: string;
  reasoning: string | null;
}

// ============================================================
// ENTITY RESOLUTION
// ============================================================

function extractDomain(s: string): string | null {
  // "someone@hccfl.edu" → "hccfl.edu"
  // "hccfl.edu" → "hccfl.edu"
  const emailMatch = s.match(/@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  if (emailMatch) return emailMatch[1].toLowerCase();
  const domainMatch = s.match(/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/);
  if (domainMatch) return s.toLowerCase();
  return null;
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ============================================================
// DATA FETCHERS
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

async function searchM365Emails(
  domain: string | null,
  name: string,
  limit: number
): Promise<ContextEmail[]> {
  try {
    const token = await getM365Token();
    if (!token) return [];
    const userEmail = Netlify.env.get("M365_USER_EMAIL") || "";

    // Microsoft Graph $search works across from/to/subject/body
    const searchTerm = domain ? `"${domain}"` : `"${name}"`;
    const url =
      `https://graph.microsoft.com/v1.0/users/${userEmail}/messages` +
      `?$search=${encodeURIComponent(searchTerm)}` +
      `&$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview` +
      `&$top=${limit}`;
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        ConsistencyLevel: "eventual",
      },
    });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.value || []).map((m: any): ContextEmail => {
      const fromAddr = m.from?.emailAddress?.address || "";
      const toAddrs = (m.toRecipients || [])
        .map((r: any) => r.emailAddress?.address || "")
        .join(", ");
      const direction: "inbound" | "outbound" =
        fromAddr.toLowerCase() === userEmail.toLowerCase() ? "outbound" : "inbound";
      return {
        id: m.id,
        account: "m365",
        direction,
        from: fromAddr,
        to: toAddrs,
        subject: m.subject || "(no subject)",
        preview: (m.bodyPreview || "").slice(0, 300).replace(/\s+/g, " "),
        receivedAt: m.receivedDateTime,
        bucket: null,
      };
    });
  } catch {
    return [];
  }
}

async function searchM365CalendarFor(
  domain: string | null,
  name: string
): Promise<ContextEvent[]> {
  try {
    const token = await getM365Token();
    if (!token) return [];
    const userEmail = Netlify.env.get("M365_USER_EMAIL") || "";

    // Pull last 180 days + next 60 days of events, filter client-side by attendee
    const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString();
    const sixtyDaysOut = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString();
    const url =
      `https://graph.microsoft.com/v1.0/users/${userEmail}/calendarView` +
      `?startDateTime=${sixMonthsAgo}&endDateTime=${sixtyDaysOut}` +
      `&$select=id,subject,start,end,location,attendees&$top=250` +
      `&$orderby=start/dateTime desc`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Prefer: `outlook.timezone="${TZ}"` },
    });
    if (!r.ok) return [];
    const d = await r.json();
    const normalizedName = normalizeForMatch(name);
    return (d.value || [])
      .filter((e: any) => {
        const attendees = (e.attendees || []).map((a: any) =>
          (a.emailAddress?.address || "").toLowerCase()
        );
        const attendeeNames = (e.attendees || []).map((a: any) =>
          normalizeForMatch(a.emailAddress?.name || "")
        );
        if (domain && attendees.some((a: string) => a.endsWith("@" + domain))) return true;
        if (attendeeNames.some((n: string) => n.includes(normalizedName))) return true;
        const subjectNorm = normalizeForMatch(e.subject || "");
        if (normalizedName && subjectNorm.includes(normalizedName)) return true;
        return false;
      })
      .map((e: any): ContextEvent => ({
        id: e.id,
        subject: e.subject || "(untitled)",
        start: e.start?.dateTime || "",
        end: e.end?.dateTime || "",
        attendees: (e.attendees || [])
          .map((a: any) => a.emailAddress?.name || a.emailAddress?.address)
          .filter(Boolean),
        location: e.location?.displayName || null,
      }));
  } catch {
    return [];
  }
}

async function fetchTasksMatching(
  domain: string | null,
  name: string
): Promise<ContextTask[]> {
  try {
    const store = getStore({ name: "sam-tasks", consistency: "eventual" });
    const { blobs } = await store.list();
    const normalizedName = normalizeForMatch(name);
    const tasks: ContextTask[] = [];
    for (const b of blobs) {
      try {
        const t = (await store.get(b.key, { type: "json" })) as any;
        if (!t) continue;
        const haystack = normalizeForMatch(
          [t.title, t.notes, t.project, t.client].filter(Boolean).join(" ")
        );
        const matches =
          (normalizedName && haystack.includes(normalizedName)) ||
          (domain && haystack.includes(normalizeForMatch(domain)));
        if (matches) {
          tasks.push({
            id: t.id || b.key,
            title: t.title || "(untitled)",
            status: t.status || "pending",
            priority: t.priority || null,
            dueDate: t.dueDate || null,
            createdAt: t.createdAt || null,
          });
        }
      } catch {}
    }
    return tasks;
  } catch {
    return [];
  }
}

async function fetchTranscriptsMatching(
  domain: string | null,
  name: string
): Promise<ContextTranscript[]> {
  try {
    const store = getStore({ name: "sam-zoom-transcripts", consistency: "eventual" });
    const { blobs } = await store.list();
    const normalizedName = normalizeForMatch(name);
    const results: ContextTranscript[] = [];
    for (const b of blobs.slice(0, 100)) {
      try {
        const t = (await store.get(b.key, { type: "json" })) as any;
        if (!t) continue;
        const haystack = normalizeForMatch(
          [t.topic, t.transcript, (t.participants || []).join(" ")].filter(Boolean).join(" ")
        );
        const matches =
          (normalizedName && haystack.includes(normalizedName)) ||
          (domain && haystack.includes(normalizeForMatch(domain)));
        if (matches) {
          const transcript = t.transcript || "";
          // Find the most relevant excerpt around the name mention
          const needle = normalizedName || normalizeForMatch(domain || "");
          const rawText = transcript.toLowerCase();
          const idx = rawText.indexOf(needle.slice(0, 20));
          const excerptStart = Math.max(0, idx - 150);
          const excerpt =
            idx >= 0
              ? transcript.slice(excerptStart, excerptStart + 500)
              : transcript.slice(0, 500);
          results.push({
            id: t.id || b.key,
            topic: t.topic || "(untitled)",
            meetingDate: t.meetingDate || t.createdAt || "",
            excerpt: excerpt.replace(/\s+/g, " "),
          });
        }
      } catch {}
    }
    return results;
  } catch {
    return [];
  }
}

async function fetchDecisionsMatching(
  domain: string | null,
  name: string
): Promise<ContextDecision[]> {
  try {
    const store = getStore({ name: "sam-decisions", consistency: "eventual" });
    const { blobs } = await store.list();
    const normalizedName = normalizeForMatch(name);
    const results: ContextDecision[] = [];
    for (const b of blobs) {
      try {
        const d = (await store.get(b.key, { type: "json" })) as any;
        if (!d) continue;
        const haystack = normalizeForMatch(
          [d.summary, d.reasoning, d.context].filter(Boolean).join(" ")
        );
        const matches =
          (normalizedName && haystack.includes(normalizedName)) ||
          (domain && haystack.includes(normalizeForMatch(domain)));
        if (matches) {
          results.push({
            id: d.id || b.key,
            decidedAt: d.decidedAt || d.createdAt || "",
            summary: d.summary || "",
            reasoning: d.reasoning || null,
          });
        }
      } catch {}
    }
    return results;
  } catch {
    return [];
  }
}

// ============================================================
// ORCHESTRATOR
// ============================================================

export async function buildContext(rawEntity: string): Promise<ContextBundle> {
  const start = Date.now();
  const entity = rawEntity.trim();
  const domain = extractDomain(entity);
  const nameForMatch = domain ? entity.replace(domain, "").replace(/@/g, "").trim() : entity;

  const [emails, events, tasks, transcripts, decisions] = await Promise.all([
    searchM365Emails(domain, nameForMatch, 50),
    searchM365CalendarFor(domain, nameForMatch),
    fetchTasksMatching(domain, nameForMatch),
    fetchTranscriptsMatching(domain, nameForMatch),
    fetchDecisionsMatching(domain, nameForMatch),
  ]);

  // Derive relationship stats
  const sortedEmails = [...emails].sort(
    (a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime()
  );
  const firstSeen = sortedEmails[0]?.receivedAt || events[events.length - 1]?.start || null;
  const lastContactCandidates = [
    sortedEmails[sortedEmails.length - 1]?.receivedAt,
    events[0]?.start,
    transcripts[0]?.meetingDate,
  ].filter(Boolean) as string[];
  const lastContact = lastContactCandidates.length
    ? lastContactCandidates.sort().reverse()[0]
    : null;

  // Unanswered: last N inbound emails where no outbound email followed within 72h
  let unansweredFromThem = 0;
  const inbound = emails.filter((e) => e.direction === "inbound").sort(
    (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
  );
  const outbound = emails.filter((e) => e.direction === "outbound");
  for (const i of inbound.slice(0, 10)) {
    const iTime = new Date(i.receivedAt).getTime();
    const replied = outbound.some((o) => {
      const oTime = new Date(o.receivedAt).getTime();
      return oTime > iTime && oTime - iTime < 7 * 24 * 3600 * 1000;
    });
    if (!replied) unansweredFromThem++;
  }

  // Last reply David sent them — voice seed for future drafts
  const lastReplySent = outbound.sort(
    (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
  )[0];

  // Collect all unique display names we saw
  const namesSeen = new Set<string>();
  for (const e of events) for (const a of e.attendees) namesSeen.add(a);
  const resolvedNames = Array.from(namesSeen).slice(0, 10);

  return {
    entity,
    resolvedDomain: domain,
    resolvedNames,
    emails: emails.sort(
      (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
    ),
    events: events.sort(
      (a, b) => new Date(b.start).getTime() - new Date(a.start).getTime()
    ),
    tasks,
    transcripts: transcripts.sort(
      (a, b) => new Date(b.meetingDate).getTime() - new Date(a.meetingDate).getTime()
    ),
    decisions: decisions.sort(
      (a, b) => new Date(b.decidedAt).getTime() - new Date(a.decidedAt).getTime()
    ),
    lastReplySent: lastReplySent ? lastReplySent.preview : null,
    relationship: {
      firstSeen,
      lastContact,
      totalEmails: emails.length,
      totalMeetings: events.length,
      unansweredFromThem,
    },
    durationMs: Date.now() - start,
  };
}
