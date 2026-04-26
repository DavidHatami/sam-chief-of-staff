# SAM — Architecture Migration Status

Last updated: 2026-04-26

This doc captures where SAM stands after the multi-session migration from a
closed-loop module architecture (everything writes to its own Netlify Blob)
to a relational core with an event log and reactor pipeline (Postgres +
domain events + LISTEN/NOTIFY + scheduled reactors).

## What changed and why

Before: each module owned its own blob storage and read/wrote nothing
across modules. tasks.mts wrote to sam-tasks blob; memory-extract wrote to
sam-knowledge blob; triage to sam-triage; nothing connected. A task that
mentioned a person had no way to link to that person. The "Chief of Staff"
abstraction was undermined by the underlying plumbing.

After: every entity has a stable UUID in Postgres. Every state change
produces an immutable event row. Reactors subscribe to event types and
produce side effects (linking, updating, summarizing). The dashboard can
ask cross-cutting questions because the data is relational and the history
is durable.

## Phase status

| Phase | Title                      | State           | Verified live          |
|-------|----------------------------|-----------------|------------------------|
| 0     | Decisions                  | done            | n/a                    |
| 1     | Postgres + dual-write      | done            | yes — CRUD round-trip  |
| 2     | Backfill blob → PG         | done            | yes — 16 tasks         |
| 3     | Read cutover (with fallback) | done          | yes — flag flipped     |
| 4     | Stop blob writes           | DEFERRED        | wait 1 wk stable PG    |
| 5     | Reactor framework + audit_logger | done      | yes — 29 reactions    |
| 6     | Realtime to frontend       | not started     | needs frontend session |
| 7     | Inngest workflows          | not started     | needs Inngest signup   |
| 8     | Cost tracking              | done            | endpoint verified      |
| 9     | Ops hardening              | partial         | system-health live     |
| 10    | Auth migration / RLS       | optional        | not scheduled          |

## What's running right now

- **Postgres at supabase.com/project/anyzoldibhkfmjshpglk** holds the
  relational core. 18 tables, full schema applied via migrations 001-008.
- **tasks.mts** dual-writes every CREATE/UPDATE/DELETE to PG with atomic
  event emission via stored procedures. Reads come from PG when
  `read_from_pg_tasks` flag is on (currently true), falls back to blobs
  on any error.
- **memory-extract.ts** dual-writes new people / initiatives / preferences
  / decisions to PG via the upsert RPCs. Cost tracking instrumented.
- **ai.mts** chat endpoint records token usage to `model_costs` for every
  Anthropic / OpenAI / Gemini call. Includes single-engine and council
  modes.
- **reactor-scheduled.mts** runs every minute. Polls events, dispatches to
  audit_logger reactor, mirrors to audit_log.
- **audit-retention-scheduled.mts** runs daily at 04:00 UTC. Trims
  audit_log to a 90-day rolling window.

## Endpoints added

| Path | Purpose |
|------|---------|
| `/api/admin/pg-probe` | Verifies every step of the PG connection chain |
| `/api/admin/backfill` | Idempotent blob → PG migration (dry-run by default) |
| `/api/admin/reactor-run` | Manually trigger a reactor sweep |
| `/api/admin/cost-summary` | Aggregated AI usage and cost by day/model/feature |
| `/api/admin/system-health` | Probes every dependency in parallel |

## Feature flags (table `sam_meta`, key `flags`)

| Flag | Current | Meaning |
|------|---------|---------|
| `dual_write_tasks` | true | task mutations land in PG and blob |
| `dual_write_memory` | true | memory extractions land in PG and blob |
| `dual_write_triage` | false | not yet wired (Phase 1.5) |
| `dual_write_anticipations` | false | not yet wired |
| `read_from_pg_tasks` | true | tasks API reads PG, falls back to blob |
| `read_from_pg_memory` | false | memory API still reads blob |
| `events_enabled` | true | events table accepts inserts |
| `reactor_enabled` | true | reactor cron processes events |
| `realtime_enabled` | false | no Realtime channel subscribed yet |

Flip a flag with: `UPDATE sam_meta SET value = jsonb_set(value, '{flag_name}', 'true'::jsonb) WHERE key = 'flags';`
Cache TTL is 30s — a fresh value propagates to all warm function instances within ~30 seconds.

## What can break, and how to debug

**Postgres unreachable** → SAM still serves. Every PG write is wrapped in
try/catch; failures log to the function logs but don't surface to user.
Reads fall back to blob automatically. To diagnose: `curl /api/admin/pg-probe`.

**Reactor stops firing** → `audit_log` stops growing. To diagnose:
`curl /api/admin/reactor-run` for a manual sweep, then check Netlify cron
logs for `[reactor-cron]` entries.

**Cost tracking gives 0 dollars** → expected until pricing is filled in.
Edit `PRICING` constants in `netlify/lib/llm-cost.ts` with verified rates
from each provider's billing dashboard. Token counts are accurate today.

**Divergence between blob and PG** → run `/api/admin/backfill?confirm=yes`.
The function is idempotent: it skips entities already in PG, so re-running
is safe.

## What's NOT instrumented for cost yet

- `triage-core.ts` — triage classification calls Anthropic
- `anticipations-lib.ts` — anticipations generator calls Anthropic
- `review-core.ts` — weekly review calls Anthropic
- `transcripts-core.ts` — transcript-to-tasks calls Anthropic
- `briefing.mts` — daily briefing calls Anthropic

Each is a single fetch call per file. Pattern: import `trackCost` from
`../lib/llm-cost.ts`, wrap the response parse with the same try/catch
pattern used in ai.mts. Can be added incrementally without coordinating
across files.

## Known divergences and TODOs

- **memory.mts PUT** (admin override for the knowledge blob) does not
  currently dual-write. If David uses the snapshot/restore E2E flow, PG
  will diverge. Fix: add corresponding upsert calls or run backfill after.
- **No RLS policies** on any PG table. Acceptable for single-tenant SAM.
  Phase 10 tightens this if/when SAM goes multi-user.
- **Postgres free tier** has limits (500 MB DB, 5 GB egress/month). At
  current event volume (~30/day) this lasts effectively forever. If David
  enables high-traffic features, watch the database size in the Supabase
  dashboard.

## Repository hygiene

All commits since this work began are on `master`. No feature branches.
Convention preserved: `*-scheduled.mts` for cron-only, `*.mts` for HTTP.

## Resume-here-if-needed

If a future session needs to pick this up: read `STATUS.md` first, then
`netlify/lib/sam-db.ts` (mutation layer), then `netlify/lib/reactor.ts`
(event pipeline), then `netlify/lib/llm-cost.ts` (cost tracking). Those
three files contain the architectural shifts; everything else is
plumbing or instrumentation.


<!-- redeploy 12434fa7 → cloud-mode signing key -->
