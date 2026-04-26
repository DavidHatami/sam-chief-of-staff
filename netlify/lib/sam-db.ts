/**
 * SAM DATABASE LAYER — Supabase / Postgres client
 *
 * This module is the bridge between SAM's existing blob-based storage and
 * the new Postgres relational core. Every mutation goes through this module
 * and is persisted to BOTH stores during the migration window (Phase 1-3).
 *
 * Design rules:
 *   1. ATOMIC mutations via stored procedures: every entity change AND its
 *      corresponding event row are written in ONE Postgres transaction. If
 *      either fails, neither lands. This is the transactional outbox pattern.
 *
 *   2. DUAL-WRITE during migration: callers wrap blob writes around PG
 *      writes. If PG fails, blob still succeeds — SAM keeps working. Errors
 *      from PG are logged, never thrown to user.
 *
 *   3. EVENT EMISSION is non-optional. Every state change MUST produce an
 *      event. The reactor and frontend Realtime depend on this contract.
 *
 *   4. NULL-SAFE: missing env vars return null client; callers handle null
 *      gracefully so SAM keeps running if Supabase is unreachable.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;
let _initAttempted = false;

/**
 * Get or create the singleton Supabase client. Returns null if env is
 * missing — callers must handle this case so SAM keeps working when PG
 * is unreachable. We cache the client across function invocations within
 * the same warm container.
 */
export function getDb(): SupabaseClient | null {
  if (_client) return _client;
  if (_initAttempted && !_client) return null; // already failed once, don't keep retrying

  _initAttempted = true;
  // @ts-ignore - Netlify global
  const url = typeof Netlify !== "undefined" ? Netlify.env.get("SUPABASE_URL") : process.env.SUPABASE_URL;
  // @ts-ignore - Netlify global
  const key = typeof Netlify !== "undefined" ? Netlify.env.get("SUPABASE_PUBLISHABLE_KEY") : process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) {
    console.warn("[sam-db] SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY not set; running in blob-only mode");
    return null;
  }

  try {
    _client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      // Keep network simple — no realtime subscriptions in this server-side client
      realtime: { params: { eventsPerSecond: 0 } },
    });
    return _client;
  } catch (e: any) {
    console.error("[sam-db] init failed:", e?.message || e);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// EVENT EMISSION
// ─────────────────────────────────────────────────────────────────────────

export interface EmitEventInput {
  type: string;
  entityType?: string;
  entityId?: string;
  payload?: Record<string, any>;
  source?: string;
  correlationId?: string;
}

/**
 * Emit a domain event. Used standalone when there's no entity mutation —
 * e.g. logging an external occurrence. For entity mutations, prefer the
 * specific create/update/delete helpers below which emit atomically.
 */
export async function emitEvent(input: EmitEventInput): Promise<string | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const { data, error } = await db.rpc("sam_emit_event", {
      p_type: input.type,
      p_entity_type: input.entityType ?? null,
      p_entity_id: input.entityId ?? null,
      p_payload: input.payload ?? {},
      p_source: input.source ?? null,
      p_correlation_id: input.correlationId ?? null,
    });
    if (error) {
      console.error("[sam-db] emitEvent rpc error:", error.message);
      return null;
    }
    return data as string;
  } catch (e: any) {
    console.error("[sam-db] emitEvent threw:", e?.message || e);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// TASK MUTATIONS (atomic via stored procs)
// ─────────────────────────────────────────────────────────────────────────

export interface CreateTaskInput {
  legacyId: string;
  title: string;
  description?: string;
  priority?: string;
  status?: string;
  category?: string;
  dueDate?: string | null;
  notes?: string;
  subtasks?: any[];
  source?: string;
  correlationId?: string;
}

export async function createTask(input: CreateTaskInput): Promise<{ taskId: string; eventId: string } | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const { data, error } = await db.rpc("sam_create_task", {
      p_legacy_id: input.legacyId,
      p_title: input.title,
      p_description: input.description ?? null,
      p_priority: input.priority ?? "normal",
      p_status: input.status ?? "todo",
      p_category: input.category ?? null,
      p_due_date: input.dueDate || null,
      p_notes: input.notes ?? null,
      p_subtasks: input.subtasks ?? [],
      p_source: input.source ?? "api",
      p_correlation_id: input.correlationId ?? null,
    });
    if (error) {
      console.error("[sam-db] createTask error:", error.message);
      return null;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    return { taskId: row.task_id, eventId: row.event_id };
  } catch (e: any) {
    console.error("[sam-db] createTask threw:", e?.message || e);
    return null;
  }
}

/** Look up a task by its legacy blob id (used during dual-write transition). */
export async function findTaskByLegacyId(legacyId: string): Promise<{ id: string } | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const { data, error } = await db.from("tasks").select("id").eq("legacy_id", legacyId).maybeSingle();
    if (error) {
      console.error("[sam-db] findTaskByLegacyId:", error.message);
      return null;
    }
    return data;
  } catch (e: any) {
    console.error("[sam-db] findTaskByLegacyId threw:", e?.message || e);
    return null;
  }
}

export async function updateTask(taskId: string, patch: Record<string, any>, source: string = "api"): Promise<string | null> {
  const db = getDb();
  if (!db) return null;
  // Snake-case the patch keys (JS dueDate -> SQL due_date, etc.)
  const sqlPatch: Record<string, any> = {};
  if ("title" in patch) sqlPatch.title = patch.title;
  if ("description" in patch) sqlPatch.description = patch.description;
  if ("priority" in patch) sqlPatch.priority = patch.priority;
  if ("status" in patch) sqlPatch.status = patch.status;
  if ("category" in patch) sqlPatch.category = patch.category;
  if ("dueDate" in patch || "due_date" in patch) sqlPatch.due_date = patch.dueDate || patch.due_date || null;
  if ("notes" in patch) sqlPatch.notes = patch.notes;
  if ("subtasks" in patch) sqlPatch.subtasks = patch.subtasks;
  try {
    const { data, error } = await db.rpc("sam_update_task", {
      p_id: taskId,
      p_patch: sqlPatch,
      p_source: source,
      p_correlation_id: null,
    });
    if (error) {
      console.error("[sam-db] updateTask error:", error.message);
      return null;
    }
    return data as string;
  } catch (e: any) {
    console.error("[sam-db] updateTask threw:", e?.message || e);
    return null;
  }
}

/** Update by legacy id (the format used by the blob-based API). Resolves to UUID first. */
export async function updateTaskByLegacyId(legacyId: string, patch: Record<string, any>, source: string = "api"): Promise<string | null> {
  const found = await findTaskByLegacyId(legacyId);
  if (!found) return null;
  return updateTask(found.id, patch, source);
}

export async function deleteTask(taskId: string, source: string = "api"): Promise<string | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const { data, error } = await db.rpc("sam_delete_task", {
      p_id: taskId,
      p_source: source,
      p_correlation_id: null,
    });
    if (error) {
      console.error("[sam-db] deleteTask error:", error.message);
      return null;
    }
    return data as string;
  } catch (e: any) {
    console.error("[sam-db] deleteTask threw:", e?.message || e);
    return null;
  }
}

export async function deleteTaskByLegacyId(legacyId: string, source: string = "api"): Promise<string | null> {
  const found = await findTaskByLegacyId(legacyId);
  if (!found) return null;
  return deleteTask(found.id, source);
}

// ─────────────────────────────────────────────────────────────────────────
// MEMORY ENTITY MUTATIONS (people, initiatives, preferences, decisions)
// ─────────────────────────────────────────────────────────────────────────

export async function upsertPerson(input: {
  name: string;
  facts?: string[];
  emails?: string[];
  org?: string;
  role?: string;
  source?: string;
  correlationId?: string;
}): Promise<{ personId: string; eventId: string; action: string } | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const { data, error } = await db.rpc("sam_upsert_person", {
      p_name: input.name,
      p_facts: input.facts ?? [],
      p_emails: input.emails ?? [],
      p_org: input.org ?? null,
      p_role: input.role ?? null,
      p_source: input.source ?? "memory_extract",
      p_correlation_id: input.correlationId ?? null,
    });
    if (error) {
      console.error("[sam-db] upsertPerson error:", error.message);
      return null;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    return { personId: row.person_id, eventId: row.event_id, action: row.action };
  } catch (e: any) {
    console.error("[sam-db] upsertPerson threw:", e?.message || e);
    return null;
  }
}

export async function upsertInitiative(input: {
  name: string;
  status?: string;
  facts?: string[];
  source?: string;
  correlationId?: string;
}): Promise<{ initiativeId: string; eventId: string; action: string } | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const { data, error } = await db.rpc("sam_upsert_initiative", {
      p_name: input.name,
      p_status: input.status ?? null,
      p_facts: input.facts ?? [],
      p_source: input.source ?? "memory_extract",
      p_correlation_id: input.correlationId ?? null,
    });
    if (error) {
      console.error("[sam-db] upsertInitiative error:", error.message);
      return null;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    return { initiativeId: row.initiative_id, eventId: row.event_id, action: row.action };
  } catch (e: any) {
    console.error("[sam-db] upsertInitiative threw:", e?.message || e);
    return null;
  }
}

export async function insertPreference(text: string, source: string = "memory_extract"): Promise<string | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const { data, error } = await db.from("preferences").insert({ text }).select("id").single();
    if (error || !data) {
      if (error) console.error("[sam-db] insertPreference error:", error.message);
      return null;
    }
    await emitEvent({
      type: "preference.created",
      entityType: "preference",
      entityId: data.id,
      payload: { text },
      source,
    });
    return data.id;
  } catch (e: any) {
    console.error("[sam-db] insertPreference threw:", e?.message || e);
    return null;
  }
}

export async function insertDecision(input: { text: string; context?: string; initiativeId?: string; source?: string }): Promise<string | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const { data, error } = await db
      .from("decisions")
      .insert({ text: input.text, context: input.context ?? null, initiative_id: input.initiativeId ?? null })
      .select("id")
      .single();
    if (error || !data) {
      if (error) console.error("[sam-db] insertDecision error:", error.message);
      return null;
    }
    await emitEvent({
      type: "decision.created",
      entityType: "decision",
      entityId: data.id,
      payload: { text: input.text, context: input.context, initiativeId: input.initiativeId },
      source: input.source ?? "memory_extract",
    });
    return data.id;
  } catch (e: any) {
    console.error("[sam-db] insertDecision threw:", e?.message || e);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// FEATURE FLAGS — read from sam_meta so we can flip behavior without redeploy
// ─────────────────────────────────────────────────────────────────────────

let _flagsCache: { flags: Record<string, boolean>; fetchedAt: number } | null = null;
const FLAGS_TTL_MS = 30_000; // re-fetch every 30 seconds

export async function getFlags(): Promise<Record<string, boolean>> {
  if (_flagsCache && Date.now() - _flagsCache.fetchedAt < FLAGS_TTL_MS) return _flagsCache.flags;
  const db = getDb();
  if (!db) return {};
  try {
    const { data, error } = await db.from("sam_meta").select("value").eq("key", "flags").single();
    if (error || !data) return {};
    const flags = (data.value as Record<string, boolean>) || {};
    _flagsCache = { flags, fetchedAt: Date.now() };
    return flags;
  } catch (e: any) {
    console.error("[sam-db] getFlags threw:", e?.message || e);
    return {};
  }
}

export async function isFlagOn(name: string): Promise<boolean> {
  const flags = await getFlags();
  return flags[name] === true;
}

// ─────────────────────────────────────────────────────────────────────────
// MODEL COST TRACKING — every paid API call records a row
// ─────────────────────────────────────────────────────────────────────────

export async function recordModelCost(input: {
  model: string;
  feature: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costCents: number;
  metadata?: Record<string, any>;
}): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db.from("model_costs").insert({
      model: input.model,
      feature: input.feature,
      input_tokens: input.inputTokens,
      output_tokens: input.outputTokens,
      cached_input_tokens: input.cachedInputTokens ?? 0,
      cost_cents: input.costCents,
      metadata: input.metadata ?? {},
    });
  } catch (e: any) {
    console.error("[sam-db] recordModelCost threw:", e?.message || e);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// READS — used in Phase 3+ when reads switch from blobs to PG
// ─────────────────────────────────────────────────────────────────────────

export async function listTasksFromPG(): Promise<any[] | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const { data, error } = await db
      .from("tasks")
      .select("id, legacy_id, title, description, priority, status, category, due_date, notes, subtasks, created_at, updated_at")
      .order("priority", { ascending: true })
      .order("created_at", { ascending: false });
    if (error) {
      console.error("[sam-db] listTasksFromPG:", error.message);
      return null;
    }
    return data;
  } catch (e: any) {
    console.error("[sam-db] listTasksFromPG threw:", e?.message || e);
    return null;
  }
}

export async function getKnowledgeFromPG(): Promise<{ people: any[]; initiatives: any[]; preferences: any[]; decisions: any[] } | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const [people, initiatives, preferences, decisions] = await Promise.all([
      db.from("people").select("id, name, facts, emails, org, role, last_mentioned_at"),
      db.from("initiatives").select("id, name, status, facts, last_updated_at"),
      db.from("preferences").select("id, text, extracted_at"),
      db.from("decisions").select("id, text, context, decided_at, initiative_id"),
    ]);
    if (people.error || initiatives.error || preferences.error || decisions.error) {
      console.error("[sam-db] getKnowledgeFromPG: error reading one or more tables");
      return null;
    }
    return {
      people: people.data || [],
      initiatives: initiatives.data || [],
      preferences: preferences.data || [],
      decisions: decisions.data || [],
    };
  } catch (e: any) {
    console.error("[sam-db] getKnowledgeFromPG threw:", e?.message || e);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// PHASE 10 — CHAT TURN PERSISTENCE + SEMANTIC SEARCH
// ─────────────────────────────────────────────────────────────────────────

/**
 * Insert a single chat turn (user or assistant) into chat_turns.
 * Returns the new row's UUID, or null if PG is down. Best-effort —
 * does not throw, so the caller can keep dual-writing to blob.
 */
export async function recordChatTurn(input: {
  role: "user" | "assistant";
  content: string;
  model?: string;
  metadata?: Record<string, any>;
}): Promise<string | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const { data, error } = await db
      .from("chat_turns")
      .insert({
        role: input.role,
        content: input.content,
        model: input.model || null,
        metadata: input.metadata || {},
      })
      .select("id")
      .single();
    if (error) {
      console.error("[sam-db] recordChatTurn error:", error.message);
      return null;
    }
    return data?.id || null;
  } catch (e: any) {
    console.error("[sam-db] recordChatTurn threw:", e?.message || e);
    return null;
  }
}

/**
 * Persist a 1536-dim embedding for a chat turn. The vector type round-trips
 * cleanly as a JS number array through supabase-js.
 */
export async function recordChatEmbedding(input: {
  turnId: string;
  embedding: number[];
  model?: string;
}): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  if (!input.embedding || input.embedding.length !== 1536) return false;
  try {
    const { error } = await db
      .from("chat_embeddings")
      .upsert({
        turn_id: input.turnId,
        embedding: input.embedding as any,
        model: input.model || "text-embedding-3-small",
      });
    if (error) {
      console.error("[sam-db] recordChatEmbedding error:", error.message);
      return false;
    }
    return true;
  } catch (e: any) {
    console.error("[sam-db] recordChatEmbedding threw:", e?.message || e);
    return false;
  }
}

/**
 * Vector search across all past user turns. Calls the search_chat_turns
 * Postgres function which uses the HNSW index for cosine similarity.
 * Returns matched user turns plus the assistant reply that followed each one.
 */
export async function searchChatTurns(input: {
  embedding: number[];
  k?: number;
  minScore?: number;
}): Promise<Array<{
  user_turn_id: string;
  user_content: string;
  user_at: string;
  assistant_content: string | null;
  assistant_at: string | null;
  similarity: number;
}> | null> {
  const db = getDb();
  if (!db) return null;
  if (!input.embedding || input.embedding.length !== 1536) return null;
  try {
    const { data, error } = await db.rpc("search_chat_turns", {
      query_embedding: input.embedding as any,
      match_count: input.k ?? 6,
      min_score: input.minScore ?? 0.28,
    });
    if (error) {
      console.error("[sam-db] searchChatTurns error:", error.message);
      return null;
    }
    return data || [];
  } catch (e: any) {
    console.error("[sam-db] searchChatTurns threw:", e?.message || e);
    return null;
  }
}
