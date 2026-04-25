import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { buildAnticipations, type Anticipation, type AnticipationSet } from "../lib/anticipations-lib.ts";
import { EMPTY_KNOWLEDGE, type Knowledge } from "../lib/memory-extract.ts";

/**
 * SAM ANTICIPATIONS — proactive nudges
 *
 *   GET    /api/anticipations            → today's anticipation set
 *   POST   /api/anticipations/generate   → build now (don't wait for cron)
 *   PATCH  /api/anticipations/:id        → dismiss/un-dismiss
 */

function todayET(): string {
  const now = new Date();
  // Convert to ET — quick approximation, good enough for date label
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return et.toISOString().split("T")[0];
}

async function gatherCurrentState(siteOrigin: string) {
  const headers = { "User-Agent": "SAM-Anticipations" };

  const startISO = new Date().toISOString();
  const endISO = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString();

  const [m365cal, gcal, tasks, m365mail, triage] = await Promise.all([
    fetch(`${siteOrigin}/api/m365/calendar?start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`, { headers }).then((r) => r.json()).catch(() => ({})),
    fetch(`${siteOrigin}/api/gcal/events?start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`, { headers }).then((r) => r.json()).catch(() => ({})),
    fetch(`${siteOrigin}/api/tasks/`, { headers }).then((r) => r.json()).catch(() => ({})),
    fetch(`${siteOrigin}/api/m365/mail?folder=inbox&top=15`, { headers }).then((r) => r.json()).catch(() => ({})),
    fetch(`${siteOrigin}/api/triage/pending`, { headers }).then((r) => r.json()).catch(() => ({})),
  ]);

  const m365Events = Array.isArray(m365cal?.value) ? m365cal.value : [];
  const googleEvents = Array.isArray(gcal?.value) ? gcal.value : [];
  const allTasks = Array.isArray(tasks?.tasks) ? tasks.tasks : (Array.isArray(tasks) ? tasks : []);
  const allEmail = Array.isArray(m365mail?.value) ? m365mail.value : [];
  const unreadEmail = allEmail.filter((m: any) => !m.isRead);

  // Triage bucket counts
  const pending = Array.isArray(triage?.pending) ? triage.pending : [];
  const triageBuckets: Record<string, number> = {};
  for (const p of pending) {
    const b = p.classification || p.bucket || "other";
    triageBuckets[b] = (triageBuckets[b] || 0) + 1;
  }

  return {
    calendarEvents: [...m365Events, ...googleEvents],
    tasks: allTasks.filter((t: any) => t.status !== "done" && t.status !== "deleted"),
    unreadEmails: unreadEmail,
    triageBuckets,
  };
}

async function generateAndStore(siteOrigin: string): Promise<AnticipationSet> {
  const knowStore = getStore({ name: "sam-knowledge", consistency: "strong" });
  const anticipStore = getStore({ name: "sam-anticipations", consistency: "strong" });

  const knowledge = ((await knowStore.get("knowledge", { type: "json" })) as Knowledge | null) || EMPTY_KNOWLEDGE;
  const state = await gatherCurrentState(siteOrigin);
  const today = todayET();
  const anthropicKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!anthropicKey) {
    throw new Error("ANTHROPIC_API_KEY missing");
  }

  const anticipations = await buildAnticipations(
    {
      calendarEvents: state.calendarEvents,
      tasks: state.tasks,
      unreadEmails: state.unreadEmails,
      triageBuckets: state.triageBuckets,
      knowledge,
      today,
    },
    anthropicKey
  );

  // Preserve any dismissed flags from a prior set generated earlier today
  let prior: AnticipationSet | null = null;
  try {
    prior = (await anticipStore.get(today, { type: "json" })) as AnticipationSet | null;
  } catch {}
  if (prior?.anticipations) {
    const dismissedTitles = new Set(prior.anticipations.filter((a) => a.dismissed).map((a) => a.title.toLowerCase()));
    for (const a of anticipations) {
      if (dismissedTitles.has(a.title.toLowerCase())) {
        a.dismissed = true;
        a.dismissedAt = prior.anticipations.find((p) => p.title.toLowerCase() === a.title.toLowerCase())?.dismissedAt;
      }
    }
  }

  const set: AnticipationSet = {
    forDate: today,
    generatedAt: new Date().toISOString(),
    anticipations,
  };
  await anticipStore.setJSON(today, set);
  await anticipStore.setJSON("latest", set);
  return set;
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const anticipStore = getStore({ name: "sam-anticipations", consistency: "strong" });

  // GET /api/anticipations → return latest
  if (req.method === "GET") {
    try {
      const latest = (await anticipStore.get("latest", { type: "json" })) as AnticipationSet | null;
      return new Response(JSON.stringify(latest || { forDate: todayET(), generatedAt: null, anticipations: [] }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "private, max-age=60, stale-while-revalidate=300",
        },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e?.message || String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  }

  // POST /api/anticipations/generate → build now
  if (req.method === "POST" && url.pathname.endsWith("/generate")) {
    try {
      const reqUrl = new URL(req.url);
      const siteOrigin = `${reqUrl.protocol}//${reqUrl.host}`;
      const set = await generateAndStore(siteOrigin);
      return new Response(JSON.stringify({ ok: true, count: set.anticipations.length, set }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e?.message || String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  }

  // PATCH /api/anticipations/:id → dismiss
  if (req.method === "PATCH") {
    const idMatch = url.pathname.match(/\/api\/anticipations\/([^/]+)/);
    if (!idMatch) return new Response(JSON.stringify({ error: "Missing id in path" }), { status: 400, headers: { "Content-Type": "application/json" } });
    const id = decodeURIComponent(idMatch[1]);
    try {
      const body = await req.json().catch(() => ({}));
      const dismissed = body?.dismissed !== false;
      const today = todayET();
      const set = (await anticipStore.get(today, { type: "json" })) as AnticipationSet | null;
      if (!set) return new Response(JSON.stringify({ error: "No anticipation set for today" }), { status: 404, headers: { "Content-Type": "application/json" } });
      const target = set.anticipations.find((a) => a.id === id);
      if (!target) return new Response(JSON.stringify({ error: "Anticipation id not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
      target.dismissed = dismissed;
      target.dismissedAt = dismissed ? new Date().toISOString() : undefined;
      await anticipStore.setJSON(today, set);
      await anticipStore.setJSON("latest", set);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e?.message || String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { "Content-Type": "application/json" } });
};

export const config: Config = {
  path: ["/api/anticipations", "/api/anticipations/generate", "/api/anticipations/*"],
};
