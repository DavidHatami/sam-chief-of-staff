# SAM (Secret Agent Man) — Project Brief for Claude Code

## What this is
SAM is Dr. Hatami's personal Chief of Staff dashboard. Live at sam-chief-of-staff.netlify.app. Single-page app at `public/index.html` (~330KB), 32 Netlify serverless functions in `netlify/functions/`, 13 UI tabs.

## Hard rules — never violate
- ONLY repo is `DavidHatami/sam-chief-of-staff`. Never create new repos.
- ONLY branch is `master`. Commit directly to master. Never create `feature/*`, `claude/*`, `dev/*`, or `hotfix/*` branches.
- Never open PRs. Push to master.
- `sam-ops` is the backup repo only. Never push code there.

## Deploy chain
- `git push origin master` triggers Netlify auto-deploy. ~30–90 seconds to live.
- After every push, verify the deploy succeeded before claiming the work is done.

## Operating principles
- One change → commit → push → verify live → next change. Never stack three edits, push them together, and hope.
- `git commit` before each meaningful edit so rollback is surgical, not nuclear.
- Test locally when feasible before pushing to production.
- DOM edits to `public/index.html` via Python string manipulation are forbidden. The file is too large and too critical. Use targeted `str_replace` edits, never regex sweeps that touch the whole document.
- No new feature without a clear time-saving justification. If it's cosmetic, don't build it.

## Current state (as of April 25, 2026)

**Phase 1 AGENCY — shipped, both backend and frontend:**
- Morning briefing engine (`/api/briefing/now`, `/api/briefing/history`, `/api/briefing/get`) + dashboard "Brief Me Now" button + Briefings tab with date pills and source data
- Email triage agent (`/api/triage/*`) + Triage tab with bucket filters, approve/dismiss, bulk actions, re-run
- Calendar conflict hunter (`/api/conflicts/*`) + Conflicts tab with resolve/dismiss + re-scan
- Transcript-to-tasks: backend exists, no UI yet, summaries blob currently empty

**Phase 2 SYNTHESIS — backend mostly shipped, frontend mostly missing:**
- Unified inbox: `/api/unified-inbox` flowing 59KB of data, no UI
- Client context pages: `/api/context?entity=X` validates, no UI
- Weekly review: `/api/review/history`, `/api/review/get`, runs Sundays 10 PM UTC
- Cross-reference search: `/api/search?q=` returns hits, partial UI exists in global search

## Current technical IDs
- Netlify site ID: `cf562241-66f2-4314-872c-e42a8ca5ef62`
- AI engines wired: `claude-opus-4-6`, `gpt-5.4`, `gemini-2.5-flash`. Grok planned.
- Email accounts: M365 (admin@edupolicy.ai), Gmail (dh30111@gmail.com), Yahoo (dh30111@yahoo.com via custom IMAP warmer)
- Calendar: dual-write to M365 + Google Calendar
- Storage: Netlify Blobs (sam-tasks, sam-instructions, sam-projects, email-flags, zoom-processed, sam-backup-status, sam-briefings, sam-triage, sam-conflicts, sam-reviews, ...)
- Email send: Resend (domain edupolicy.ai DNS verification PENDING — currently lands in spam)
- Nightly backup: cron `0 7 * * *`, pushes to `DavidHatami/sam-ops/backups/sam-data-backup.json`

## Netlify Functions notes that bite
- `config.path` must be ARRAY format `["/api/x", "/api/x/*"]`. Wildcard-only string fails to match the root route. Common gotcha.
- `GOOGLE_REFRESH_TOKEN` is a Netlify-protected namespace. Use `G_REFRESH_TOKEN` instead. Same for any var prefixed with reserved words.
- Env var values containing `//` can break some MCP tooling. Set via dashboard, verify via `getAllEnvVars`.
- 26-second function execution budget on Pro plan. Client-side fetch should ceiling at 35s with AbortController.
- Edge sometimes returns 503 with body "DNS cache overflow" intermittently. Retry 3-4x with cache-buster.

## Frontend conventions
- Single `public/index.html` file holds the entire app. No build step.
- Phase 1 modules in `public/js/` (api.js, state.js, toast.js, render.js, esc.js, app.js) exist as a future-proofing foundation. Currently dormant. Path B (extracting features into modules) is roadmap, not in progress.
- New tabs follow the pattern: nav item in sidebar → `<div id="p-X" class="page">` section → `if(id==='X')loadX();` in `go()` → JS module with `loadX`, `renderX`, action handlers.
- Use existing `esc()` helper at line ~1188 for HTML escaping. Do NOT introduce a duplicate `esc()` — JS hoisting will silently override.
- Use existing `showToast(msg, 'ok'|'err')` for user feedback.
- Inline styles are the norm in this file. Don't refactor toward CSS classes without explicit request.

## How Dr. Hatami works
- Direct, execution-focused. No scope-commentary. No "would you like me to" hedging.
- Says "do all 1-5 in order" or "go" when he wants execution. Take it at face value.
- Anti-fabrication is non-negotiable. If data isn't verifiable, say so. Never invent.
- Banned phrasings live in user preferences — read them.
- Setup never repeated. All credentials in `_Secret_Agent_Man` and `SAM1` project folders. Never ask for what's already on file.

## Known pending items
- Resend DNS verification at GoDaddy for `edupolicy.ai` (SPF + DKIM CNAMEs) — see `docs/RESEND_DNS_FIX.md`. David's task.
- GoDaddy email forwarding for `dhatami@edupolicy.ai`
- Council Mode synthesis timeout fix (3-engine synthesis step times out)
- Grok addition (4th AI engine)
- Yahoo IMAP proxy refinement (no Yahoo REST API exists)
- `/api/triage/send` is a stub — marks sent but doesn't fire actual outbound email. UI surfaces this honestly.
- Conflict hunter's `proposedAlternatives` sometimes returns stale dates from the past. Logic quirk in `lib/conflicts-core.ts`.

## Roadmap (8 weeks from April 23, 2026)
- **P1 AGENCY** (wks 1–2): briefing ✓, triage ✓, conflicts ✓, transcript-to-tasks ⏳
- **P2 SYNTHESIS** (wks 3–4): unified inbox UI, client context UI, weekly review UI, vector search
- **P3 MEMORY** (wks 5–6): persistent AI context, writing voice model, relationship cards, decision log
- **P4 UBIQUITY** (wks 7–8): SMS via Twilio, Web Push, TTS voice briefings, Telegram bot
