/**
 * SAM MEMORY EXTRACTION — turns conversations into durable knowledge
 *
 * After every K new turns (or on a schedule), Claude reads the new chat
 * material and extracts:
 *   - PEOPLE David interacts with (and what we know about each)
 *   - PROJECTS / initiatives in flight
 *   - PREFERENCES (things David likes, hates, prefers)
 *   - DECISIONS that have been made
 *
 * Output is structured JSON merged into the `sam-knowledge` blob. New facts
 * augment existing entries; contradictions update the previous fact with the
 * newer one and log the change in `_history`.
 *
 * Why Claude vs a simpler regex/heuristic? Because the value of standing
 * facts depends entirely on extraction quality. "Patricia from Ohio CC" is
 * more useful than "the person David mentioned." A regex can't tell the
 * difference; a model can.
 */

export interface Person {
  name: string;
  facts: string[];
  lastMentionedAt: string;
}

export interface Project {
  name: string;
  status?: string;
  facts: string[];
  lastUpdatedAt: string;
}

export interface Preference {
  text: string;
  extractedAt: string;
}

export interface Decision {
  text: string;
  context?: string;
  decidedAt: string;
}

export interface Knowledge {
  people: Person[];
  projects: Project[];
  preferences: Preference[];
  decisions: Decision[];
  lastExtractedFromAt?: string;  // ISO timestamp of the newest turn we've extracted from
  totalExtractions?: number;
}

export const EMPTY_KNOWLEDGE: Knowledge = {
  people: [],
  projects: [],
  preferences: [],
  decisions: [],
  totalExtractions: 0,
};

/**
 * Run Claude over recent turns to extract structured knowledge.
 * Returns merged knowledge (existing + new), NOT a delta.
 */
export async function extractFromTurns(
  recentTurns: Array<{ role: string; content: string; at?: string }>,
  existing: Knowledge,
  anthropicKey: string
): Promise<Knowledge> {
  if (!recentTurns || recentTurns.length === 0) return existing;
  if (!anthropicKey) return existing;

  // Render conversation in a way the model can parse
  const transcript = recentTurns
    .map((t) => `${t.role === "user" ? "DAVID" : "SAM"}: ${t.content}`)
    .join("\n\n");

  const existingSummary = `EXISTING KNOWLEDGE (do NOT duplicate; only add what's new):

PEOPLE: ${existing.people.map((p) => p.name).join(", ") || "(none yet)"}
PROJECTS: ${existing.projects.map((p) => p.name).join(", ") || "(none yet)"}
PREFERENCES: ${existing.preferences.length} stored
DECISIONS: ${existing.decisions.length} stored`;

  const extractionPrompt = `You are extracting durable, useful facts from a recent conversation between Dr. David Hatami and his AI Chief of Staff (SAM). Your job is to identify only the things worth remembering long-term.

${existingSummary}

CONVERSATION TO EXTRACT FROM:

${transcript}

Extract a JSON object with this exact shape:

{
  "people": [
    {"name": "<proper noun>", "facts": ["<short concrete fact>", "..."]}
  ],
  "projects": [
    {"name": "<short identifier>", "status": "<current state>", "facts": ["..."]}
  ],
  "preferences": [
    {"text": "<a single durable preference David expressed>"}
  ],
  "decisions": [
    {"text": "<a clear decision David made>", "context": "<why, briefly>"}
  ]
}

RULES:
- Only extract NEW information not already covered by existing knowledge.
- Be CONCRETE. "Patricia at Ohio CC, runs admissions, slow to respond" is good. "Met someone interesting" is useless.
- Skip transient/operational chatter (greetings, smoke test alerts, casual jokes).
- Skip things David said about hypothetical situations or past examples — only real facts about HIS world.
- If a category is empty, return an empty array for that key. Don't omit keys.
- Return ONLY the JSON object. No markdown fences, no preamble, no commentary.`;

  let extracted: any = null;
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
        messages: [{ role: "user", content: extractionPrompt }],
      }),
    });
    if (!r.ok) {
      console.error(`[memory-extract] HTTP ${r.status}: ${(await r.text()).substring(0, 200)}`);
      return existing;
    }
    const data = await r.json();
    const text = data.content?.map((b: any) => (b.type === "text" ? b.text : "")).join("") || "";
    // Strip any code fences the model might have added
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    extracted = JSON.parse(cleaned);
  } catch (e: any) {
    console.error(`[memory-extract] extraction parse failed: ${e?.message || e}`);
    return existing;
  }

  if (!extracted || typeof extracted !== "object") return existing;

  // Merge into existing knowledge
  const now = new Date().toISOString();
  const merged: Knowledge = {
    people: [...existing.people],
    projects: [...existing.projects],
    preferences: [...existing.preferences],
    decisions: [...existing.decisions],
    lastExtractedFromAt: recentTurns[recentTurns.length - 1]?.at || now,
    totalExtractions: (existing.totalExtractions || 0) + 1,
  };

  // People: dedupe by lowercased name. Append new facts to existing person.
  if (Array.isArray(extracted.people)) {
    for (const p of extracted.people) {
      if (!p?.name || typeof p.name !== "string") continue;
      const norm = p.name.trim();
      if (!norm) continue;
      const existingPerson = merged.people.find((ep) => ep.name.toLowerCase() === norm.toLowerCase());
      const newFacts: string[] = Array.isArray(p.facts) ? p.facts.filter((f: any) => typeof f === "string" && f.trim()) : [];
      if (existingPerson) {
        // Append facts that aren't already present (rough exact-match dedup)
        for (const f of newFacts) {
          if (!existingPerson.facts.some((ef) => ef.toLowerCase() === f.toLowerCase())) {
            existingPerson.facts.push(f);
          }
        }
        existingPerson.lastMentionedAt = now;
      } else {
        merged.people.push({ name: norm, facts: newFacts, lastMentionedAt: now });
      }
      // Dual-write to Postgres (best-effort, fire-and-forget). The upsert
      // RPC handles both new and existing persons atomically with event emission.
      pgDualWritePerson(norm, newFacts).catch((e: any) =>
        console.error("[memory-extract] PG upsert person failed:", e?.message || e)
      );
    }
  }

  // Projects (called "initiatives" in PG to avoid name collision with the
  // separate Projects workspace concept). Same merge semantics.
  if (Array.isArray(extracted.projects)) {
    for (const p of extracted.projects) {
      if (!p?.name || typeof p.name !== "string") continue;
      const norm = p.name.trim();
      if (!norm) continue;
      const existingProj = merged.projects.find((ep) => ep.name.toLowerCase() === norm.toLowerCase());
      const newFacts: string[] = Array.isArray(p.facts) ? p.facts.filter((f: any) => typeof f === "string" && f.trim()) : [];
      if (existingProj) {
        for (const f of newFacts) {
          if (!existingProj.facts.some((ef) => ef.toLowerCase() === f.toLowerCase())) {
            existingProj.facts.push(f);
          }
        }
        if (p.status && typeof p.status === "string") existingProj.status = p.status;
        existingProj.lastUpdatedAt = now;
      } else {
        merged.projects.push({ name: norm, status: p.status, facts: newFacts, lastUpdatedAt: now });
      }
      pgDualWriteInitiative(norm, p.status, newFacts).catch((e: any) =>
        console.error("[memory-extract] PG upsert initiative failed:", e?.message || e)
      );
    }
  }

  // Preferences: dedupe by lowercased text
  if (Array.isArray(extracted.preferences)) {
    for (const pref of extracted.preferences) {
      if (!pref?.text || typeof pref.text !== "string") continue;
      const norm = pref.text.trim();
      if (!norm) continue;
      if (!merged.preferences.some((ep) => ep.text.toLowerCase() === norm.toLowerCase())) {
        merged.preferences.push({ text: norm, extractedAt: now });
        // Only dual-write to PG when it's actually NEW. Existing prefs don't get re-written.
        pgDualWritePreference(norm).catch((e: any) =>
          console.error("[memory-extract] PG insert preference failed:", e?.message || e)
        );
      }
    }
  }

  // Decisions: dedupe by lowercased text
  if (Array.isArray(extracted.decisions)) {
    for (const dec of extracted.decisions) {
      if (!dec?.text || typeof dec.text !== "string") continue;
      const norm = dec.text.trim();
      if (!norm) continue;
      if (!merged.decisions.some((ed) => ed.text.toLowerCase() === norm.toLowerCase())) {
        merged.decisions.push({ text: norm, context: dec.context, decidedAt: now });
        pgDualWriteDecision(norm, dec.context).catch((e: any) =>
          console.error("[memory-extract] PG insert decision failed:", e?.message || e)
        );
      }
    }
  }

  return merged;
}

// ─────────────────────────────────────────────────────────────────────────
// DUAL-WRITE HELPERS — every memory mutation also lands in Postgres so
// Phase 3 can cut over reads. Lazy-imported to avoid pulling Supabase JS
// into modules that don't need it.
// ─────────────────────────────────────────────────────────────────────────

async function pgDualWritePerson(name: string, facts: string[]): Promise<void> {
  if (!facts || facts.length === 0) return; // skip empty fact lists
  try {
    const { upsertPerson, isFlagOn } = await import("./sam-db.ts");
    if (!(await isFlagOn("dual_write_memory"))) return;
    await upsertPerson({ name, facts, source: "memory_extract" });
  } catch (e: any) {
    console.error("[memory-extract] pgDualWritePerson:", e?.message || e);
  }
}

async function pgDualWriteInitiative(name: string, status: string | undefined, facts: string[]): Promise<void> {
  try {
    const { upsertInitiative, isFlagOn } = await import("./sam-db.ts");
    if (!(await isFlagOn("dual_write_memory"))) return;
    await upsertInitiative({ name, status, facts, source: "memory_extract" });
  } catch (e: any) {
    console.error("[memory-extract] pgDualWriteInitiative:", e?.message || e);
  }
}

async function pgDualWritePreference(text: string): Promise<void> {
  try {
    const { insertPreference, isFlagOn } = await import("./sam-db.ts");
    if (!(await isFlagOn("dual_write_memory"))) return;
    await insertPreference(text, "memory_extract");
  } catch (e: any) {
    console.error("[memory-extract] pgDualWritePreference:", e?.message || e);
  }
}

async function pgDualWriteDecision(text: string, context: string | undefined): Promise<void> {
  try {
    const { insertDecision, isFlagOn } = await import("./sam-db.ts");
    if (!(await isFlagOn("dual_write_memory"))) return;
    await insertDecision({ text, context, source: "memory_extract" });
  } catch (e: any) {
    console.error("[memory-extract] pgDualWriteDecision:", e?.message || e);
  }
}

/**
 * Render the knowledge corpus as a system-prompt-friendly text block.
 * Goes into Claude's system prompt on every chat so it has standing context.
 */
export function knowledgeToContext(k: Knowledge): string {
  const sections: string[] = [];

  if (k.people && k.people.length > 0) {
    const peopleLines = k.people
      .slice(0, 30)  // cap at 30 most recent
      .map((p) => `  • ${p.name}: ${p.facts.slice(0, 5).join("; ")}`)
      .join("\n");
    sections.push(`PEOPLE I KNOW ABOUT:\n${peopleLines}`);
  }

  if (k.projects && k.projects.length > 0) {
    const projectLines = k.projects
      .slice(0, 20)
      .map((p) => `  • ${p.name}${p.status ? ` (${p.status})` : ""}: ${p.facts.slice(0, 4).join("; ")}`)
      .join("\n");
    sections.push(`ACTIVE PROJECTS:\n${projectLines}`);
  }

  if (k.preferences && k.preferences.length > 0) {
    const prefLines = k.preferences
      .slice(-25)  // most recent 25
      .map((p) => `  • ${p.text}`)
      .join("\n");
    sections.push(`HIS PREFERENCES:\n${prefLines}`);
  }

  if (k.decisions && k.decisions.length > 0) {
    const decLines = k.decisions
      .slice(-20)
      .map((d) => `  • ${d.text}${d.context ? ` (${d.context})` : ""}`)
      .join("\n");
    sections.push(`DECISIONS HE'S MADE:\n${decLines}`);
  }

  if (sections.length === 0) return "";

  return `\n\n[STANDING KNOWLEDGE — durable facts I've learned about David, his work, and the people/projects in his world. Use these naturally; don't recite them.]\n${sections.join("\n\n")}`;
}
