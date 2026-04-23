import { getStore } from "@netlify/blobs";

/**
 * SAM PHASE 2.4 — CROSS-REFERENCE SEARCH
 *
 * One query, every corner of SAM searched in parallel:
 *   - M365 emails (via Graph $search)
 *   - Calendar events (filtered client-side by subject/attendees)
 *   - Tasks (blob store, title/notes match)
 *   - Zoom transcripts (blob store, full-text scan with excerpt)
 *   - Decisions log
 *   - Past morning briefings
 *   - Past weekly reviews
 *
 * Keyword-based, normalized matching. This is NOT vector search — that
 * was in the original roadmap but would require adding a vector store
 * (pgvector, Qdrant, or similar), embedding every piece of content at
 * ingest time, and a cold-start embedding pipeline. Big lift for
 * marginal benefit over keyword at this data volume.
 *
 * If search quality becomes the bottleneck, Phase 3 adds vectors. For
 * now, substring + normalized-case matching covers 90% of "what did I
 * discuss with X about Y" queries.
 */

export const TZ = "America/New_York";

export interface SearchHit {
  type: "email" | "event" | "task" | "transcript" | "decision" | "briefing" | "review";
  id: string;
  title: string;
  snippet: string;
  date: string | null;
  score: number; // 0-100, higher = more relevant
  link: string | null; // deep-link path on the dashboard, when applicable
}

// ============================================================
// SCORING + MATCHING
// ============================================================

function normalize(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function scoreMatch(haystack: string, needle: string): number {
  // Base score on how many query terms hit, where they hit (title > body),
  // and whether the match is an exact phrase or spread out.
  const h = normalize(haystack);
  const n = normalize(needle);
  if (!n) return 0;
  if (h.includes(n)) return 100; // exact phrase hit
  const terms = n.split(" ").filter((t) => t.length >= 2);
  if (!terms.length) return 0;
  let hits = 0;
  for (const t of terms) if (h.includes(t)) hits++;
  return Math.round((hits / terms.length) * 75); // max 75 for scattered matches
}

function extractExcerpt(text: string, needle: string, radius: number = 160): string {
  const norm = normalize(text);
  const n = normalize(needle);
  if (!n) return text.slice(0, radius * 2);
  const idx = norm.indexOf(n);
  if (idx < 0) {
    // try first term
    const firstTerm = n.split(" ")[0];
    const i2 = norm.indexOf(firstTerm);
    if (i2 < 0) return text.slice(0, radius * 2).replace(/\s+/g, " ");
    return text
      .slice(Math.max(0, i2 - radius), i2 + radius)
      .replace(/\s+/g, " ");
  }
  return text.slice(Math.max(0, idx - radius), idx + radius).replace(/\s+/g, " ");
}

// ============================================================
// SOURCE SEARCHERS
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

async function searchEmails(q: string): Promise<SearchHit[]> {
  try {
    const token = await getM365Token();
    if (!token) return [];
    const userEmail = Netlify.env.get("M365_USER_EMAIL") || "";
    const url =
      `https://graph.microsoft.com/v1.0/users/${userEmail}/messages` +
      `?$search="${encodeURIComponent(q)}"` +
      `&$select=id,subject,from,receivedDateTime,bodyPreview&$top=25`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: "eventual" },
    });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.value || []).map((m: any): SearchHit => {
      const hay = `${m.subject || ""} ${m.bodyPreview || ""} ${m.from?.emailAddress?.address || ""}`;
      return {
        type: "email",
        id: m.id,
        title: m.subject || "(no subject)",
        snippet: extractExcerpt(m.bodyPreview || "", q),
        date: m.receivedDateTime,
        score: scoreMatch(hay, q),
        link: null,
      };
    });
  } catch {
    return [];
  }
}

async function searchEvents(q: string): Promise<SearchHit[]> {
  try {
    const token = await getM365Token();
    if (!token) return [];
    const userEmail = Netlify.env.get("M365_USER_EMAIL") || "";
    const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString();
    const ninetyDaysOut = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
    const url =
      `https://graph.microsoft.com/v1.0/users/${userEmail}/calendarView` +
      `?startDateTime=${sixMonthsAgo}&endDateTime=${ninetyDaysOut}` +
      `&$select=id,subject,start,attendees,bodyPreview&$top=250`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Prefer: `outlook.timezone="${TZ}"` },
    });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.value || [])
      .map((e: any): SearchHit => {
        const attNames = (e.attendees || [])
          .map((a: any) => a.emailAddress?.name || a.emailAddress?.address || "")
          .join(" ");
        const hay = `${e.subject || ""} ${attNames} ${e.bodyPreview || ""}`;
        return {
          type: "event",
          id: e.id,
          title: e.subject || "(untitled)",
          snippet: attNames.slice(0, 200),
          date: e.start?.dateTime || null,
          score: scoreMatch(hay, q),
          link: null,
        };
      })
      .filter((h: SearchHit) => h.score > 0);
  } catch {
    return [];
  }
}

async function searchBlobStore(
  name: string,
  type: SearchHit["type"],
  q: string,
  titleKey: string,
  bodyKeys: string[],
  dateKey: string,
  limit: number = 100
): Promise<SearchHit[]> {
  try {
    const store = getStore({ name, consistency: "eventual" });
    const { blobs } = await store.list();
    const hits: SearchHit[] = [];
    for (const b of blobs.slice(0, limit)) {
      try {
        const d = (await store.get(b.key, { type: "json" })) as any;
        if (!d) continue;
        const title = d[titleKey] || b.key;
        const body = bodyKeys.map((k) => d[k] || "").join(" ");
        const score = scoreMatch(`${title} ${body}`, q);
        if (score > 0) {
          hits.push({
            type,
            id: d.id || b.key,
            title: typeof title === "string" ? title : String(title),
            snippet: extractExcerpt(String(body), q),
            date: d[dateKey] || null,
            score,
            link: null,
          });
        }
      } catch {}
    }
    return hits;
  } catch {
    return [];
  }
}

// ============================================================
// ORCHESTRATOR
// ============================================================

export async function runSearch(q: string, opts: { limit?: number } = {}): Promise<{
  ok: true;
  query: string;
  hits: SearchHit[];
  byType: Record<string, number>;
  durationMs: number;
}> {
  const start = Date.now();
  const limit = Math.max(5, Math.min(200, opts.limit ?? 50));

  const [emails, events, tasks, transcripts, decisions, briefings, reviews] = await Promise.all([
    searchEmails(q),
    searchEvents(q),
    searchBlobStore("sam-tasks", "task", q, "title", ["notes", "project", "client"], "createdAt"),
    searchBlobStore("sam-zoom-transcripts", "transcript", q, "topic", ["transcript", "summary"], "meetingDate", 50),
    searchBlobStore("sam-decisions", "decision", q, "summary", ["reasoning", "context"], "decidedAt"),
    searchBlobStore("sam-briefings", "briefing", q, "dateLabel", ["briefing"], "generatedAt", 30),
    searchBlobStore("sam-reviews", "review", q, "weekLabel", ["review"], "generatedAt", 52),
  ]);

  const all = [...emails, ...events, ...tasks, ...transcripts, ...decisions, ...briefings, ...reviews];
  all.sort((a, b) => b.score - a.score);

  const byType: Record<string, number> = {};
  for (const h of all) byType[h.type] = (byType[h.type] || 0) + 1;

  return {
    ok: true,
    query: q,
    hits: all.slice(0, limit),
    byType,
    durationMs: Date.now() - start,
  };
}
