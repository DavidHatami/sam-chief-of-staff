import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { extractFromTurns, EMPTY_KNOWLEDGE, type Knowledge } from "../lib/memory-extract.ts";
import { withHeartbeat } from "../lib/cron-heartbeat.ts";

/**
 * SAM MEMORY EXTRACTION — scheduled (every 6 hours)
 *
 * Reads chat turns since the last extraction, runs Claude over them to extract
 * standing facts (people, projects, preferences, decisions), merges into the
 * sam-knowledge blob. The result gets injected into every future chat as
 * background context.
 *
 * Cost per run: roughly 1 Claude Opus call against ~30 turns of conversation,
 * so ~$0.05/run × 4 runs/day = ~$6/month. Cheap insurance for SAM's intelligence.
 */

export default async (req: Request, context: Context) => {
  await withHeartbeat("memory-extract-scheduled", async () => {
    const histStore = getStore({ name: "sam-chat-history", consistency: "strong" });
    const knowStore = getStore({ name: "sam-knowledge", consistency: "strong" });

    const turns = ((await histStore.get("turns", { type: "json" })) as Array<{ role: string; content: string; at?: string }> | null) || [];
    if (turns.length === 0) {
      console.log("[memory-extract] No turns yet — skipping");
      return { skipped: true, reason: "no turns" };
    }

    const existing = ((await knowStore.get("knowledge", { type: "json" })) as Knowledge | null) || EMPTY_KNOWLEDGE;

    // Only extract from turns newer than last extraction. If never extracted,
    // start with last 30 turns (don't try to digest the entire chat history at once).
    let toExtract = turns;
    if (existing.lastExtractedFromAt) {
      toExtract = turns.filter((t) => t.at && t.at > (existing.lastExtractedFromAt as string));
    } else {
      toExtract = turns.slice(-30);
    }

    if (toExtract.length === 0) {
      console.log("[memory-extract] No new turns since last extraction — skipping");
      return { skipped: true, reason: "no new turns" };
    }

    const anthropicKey = Netlify.env.get("ANTHROPIC_API_KEY");
    if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY missing");

    const updated = await extractFromTurns(toExtract, existing, anthropicKey);
    await knowStore.setJSON("knowledge", updated);

    const delta = {
      people: updated.people.length - existing.people.length,
      projects: updated.projects.length - existing.projects.length,
      preferences: updated.preferences.length - existing.preferences.length,
      decisions: updated.decisions.length - existing.decisions.length,
    };
    console.log(
      `[memory-extract] extracted from ${toExtract.length} turns: +${delta.people}p +${delta.projects}proj +${delta.preferences}pref +${delta.decisions}dec`
    );
    return { turnsExtracted: toExtract.length, delta };
  });
};

export const config: Config = {
  schedule: "0 */6 * * *",  // every 6 hours
};
