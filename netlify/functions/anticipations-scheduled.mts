import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { buildAnticipations, type AnticipationSet } from "../lib/anticipations-lib.ts";
import { EMPTY_KNOWLEDGE, type Knowledge } from "../lib/memory-extract.ts";
import { withHeartbeat } from "../lib/cron-heartbeat.ts";

/**
 * SAM ANTICIPATIONS — scheduled daily at 11 UTC (one hour after briefing-daily)
 *
 * Builds the day's proactive nudges from David's calendar, tasks, inbox, and
 * standing knowledge. Result is stored in sam-anticipations blob and surfaced
 * on the dashboard via /api/anticipations.
 *
 * Why 11 UTC (not 6 AM local): briefing-daily fires at 10 UTC = 6 AM ET. We
 * want anticipations AFTER the morning data has settled (triage has run, any
 * overnight emails are processed). So 11 UTC = 7 AM ET feels right.
 */

function todayET(): string {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return et.toISOString().split("T")[0];
}

export default async (req: Request, context: Context) => {
  await withHeartbeat("anticipations-scheduled", async () => {
    const reqUrl = new URL(req.url);
    const siteOrigin = `${reqUrl.protocol}//${reqUrl.host}`;
    const headers = { "User-Agent": "SAM-Anticipations-Cron" };

    // Pull current state in parallel
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
    const pending = Array.isArray(triage?.pending) ? triage.pending : [];
    const triageBuckets: Record<string, number> = {};
    for (const p of pending) {
      const b = p.classification || p.bucket || "other";
      triageBuckets[b] = (triageBuckets[b] || 0) + 1;
    }

    const knowStore = getStore({ name: "sam-knowledge", consistency: "strong" });
    const anticipStore = getStore({ name: "sam-anticipations", consistency: "strong" });
    const knowledge = ((await knowStore.get("knowledge", { type: "json" })) as Knowledge | null) || EMPTY_KNOWLEDGE;

    const today = todayET();
    const anthropicKey = Netlify.env.get("ANTHROPIC_API_KEY");
    if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY missing");

    const anticipations = await buildAnticipations(
      {
        calendarEvents: [...m365Events, ...googleEvents],
        tasks: allTasks.filter((t: any) => t.status !== "done" && t.status !== "deleted"),
        unreadEmails: unreadEmail,
        triageBuckets,
        knowledge,
        today,
      },
      anthropicKey
    );

    const set: AnticipationSet = {
      forDate: today,
      generatedAt: new Date().toISOString(),
      anticipations,
    };
    await anticipStore.setJSON(today, set);
    await anticipStore.setJSON("latest", set);

    const byPriority: Record<string, number> = {};
    for (const a of anticipations) byPriority[a.priority] = (byPriority[a.priority] || 0) + 1;
    console.log(`[anticipations] ${anticipations.length} generated for ${today}: high=${byPriority.high || 0} med=${byPriority.medium || 0} low=${byPriority.low || 0}`);
    return { count: anticipations.length, byPriority };
  });
};

export const config: Config = {
  schedule: "0 11 * * *",
};
