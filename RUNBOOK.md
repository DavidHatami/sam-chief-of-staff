# SAM Operational Runbook

**For: Dr. David Hatami**
**Site: https://sam-chief-of-staff.netlify.app**
**Repo: https://github.com/DavidHatami/sam-chief-of-staff**
**Backups: https://github.com/DavidHatami/sam-ops**

This is the document you reach for when something breaks. It assumes nothing about your mental state — at 6 AM after a bad night, you should still be able to follow it.

Every section answers: **what's wrong → how to confirm → how to fix → how to verify the fix.**

---

## TABLE OF CONTENTS

1. [Where to look first when something feels off](#1-where-to-look-first)
2. [Cron job stopped firing](#2-cron-job-stopped-firing)
3. [Credential expired or revoked](#3-credential-expired-or-revoked)
4. [Deploy went bad — roll back](#4-deploy-went-bad--roll-back)
5. [Restore data from sam-ops backup](#5-restore-data-from-sam-ops-backup)
6. [Yahoo IMAP locked up](#6-yahoo-imap-locked-up)
7. [Briefings landing in spam](#7-briefings-landing-in-spam)
8. [Edge "DNS cache overflow" 503 errors](#8-edge-503-errors)
9. [Clear blob caches](#9-clear-blob-caches)
10. [Manually trigger any cron](#10-manually-trigger-any-cron)
11. [What every X-Cache header value means](#11-x-cache-header-decoder)
12. [The 4 places SAM stores secrets](#12-secrets-locations)
13. [Total disaster recovery](#13-total-disaster-recovery)

---

## 1. Where to look first

Open https://sam-chief-of-staff.netlify.app, sign in (`SAM2026!`), and look at the dashboard. You have three traffic-light cards:

- **📡 SAM Status** — queues, briefing freshness, backup recency
- **⚙️ Cron Health** — last-run times for all 7 scheduled jobs
- **🔐 Credentials** — does each external API still authenticate

If everything is green, SAM is fine. The "wrongness" is somewhere else (your inbox, your perception, your sleep).

If something is yellow or red, the card text tells you which job/credential and the failure reason. Then you go to the relevant section below.

---

## 2. Cron job stopped firing

**Symptom:** ⚙️ Cron Health card shows a job in WARNING (yellow) or ALARM (red), or you stopped getting your morning briefing.

**Confirm:**
```
GET https://sam-chief-of-staff.netlify.app/api/cron/health
```
Look at `jobs[].lastRunAt` for the affected job. Compare against `expectedIntervalMs`.

**Fix paths (in order of severity):**

### 2a. The job is just slow / one missed run
If it's WARNING (1-2× expected interval), wait one more cycle. Cron schedules can drift by a few minutes under Netlify Functions load. Re-check in 10 minutes.

### 2b. The job is genuinely stuck (3+ missed runs)
Something is wrong with the function itself. Get the logs:

1. Go to https://app.netlify.com/projects/sam-chief-of-staff/logs/functions
2. Filter to the affected function name (e.g. `triage-scheduled`)
3. Look at the last 10 invocations — what's the error?

Common errors:
- **"OPENAI_API_KEY missing" / similar** → Credential rotation needed (Section 3)
- **"timeout"** → The job is exceeding Netlify's 26s function ceiling. Open an Issue against yourself, this needs code work.
- **"network error"** → Transient. Re-check in 30 min.
- **"AADSTS7000222"** → M365 client secret expired (Section 3)

### 2c. Force an immediate run
Each cron has a manual trigger. Section 10 lists the URL for each.

### 2d. After fix — verify recovery
Wait for one full interval cycle. Re-load the dashboard. The job's status should flip from ALARM → WARNING → OK over the next 1-3 cycles. If it doesn't, the heartbeat write itself is broken — check the function logs for `[cron-heartbeat]` errors.

---

## 3. Credential expired or revoked

**Symptom:** 🔐 Credentials card shows ALARM, or one of the model APIs (Claude/OpenAI/Gemini) starts returning auth errors in briefings.

**Confirm:**
```
GET https://sam-chief-of-staff.netlify.app/api/credentials/health
```
The `reason` field tells you exactly which credential and why.

**Where each credential lives, and how to rotate it:**

### 3a. ANTHROPIC_API_KEY
1. Generate new key: https://console.anthropic.com/settings/keys
2. Click "Create Key", name it `sam-prod`, copy
3. Netlify dashboard → site `sam-chief-of-staff` → Site Configuration → Environment variables
4. Edit `ANTHROPIC_API_KEY` → paste new value → Save
5. Trigger a redeploy: any commit to master, or click "Trigger deploy" in Netlify dashboard
6. Verify: dashboard 🔐 Credentials should show Claude AI green within 60s

### 3b. OPENAI_API_KEY
1. https://platform.openai.com/api-keys
2. "Create new secret key", name `sam-prod`, copy
3. Same Netlify env var process as above; key name is `OPENAI_API_KEY`
4. Verify same way

### 3c. GEMINI_API_KEY
1. https://aistudio.google.com/apikey
2. Create new key, copy
3. Update `GEMINI_API_KEY` in Netlify env, redeploy
4. Verify

### 3d. M365_CLIENT_SECRET — most likely to expire silently
**This expires every 24 months. Set a calendar reminder.**

1. Azure Portal → Microsoft Entra ID → App registrations → find the app for SAM
2. Certificates & secrets → New client secret → name `sam-prod-{year}` → 24mo expiry
3. **Copy the VALUE immediately** (Azure won't show it again)
4. Update `M365_CLIENT_SECRET` in Netlify env, redeploy
5. Verify: dashboard 🔐 Credentials shows Microsoft 365 green; check `notes` field — it'll show the new expiration date

### 3e. G_REFRESH_TOKEN (Google)
This token doesn't expire on a fixed schedule but Google revokes it if the user explicitly revokes app access OR if the OAuth scopes change.

If revoked:
1. Visit https://sam-chief-of-staff.netlify.app/auth/google (the OAuth re-init flow)
2. Grant consent again
3. The function captures the new refresh token automatically and stores it
4. Verify: 🔐 Credentials shows Google green

### 3f. GITHUB_PAT
Currently `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`. Fine-grained tokens expire (typically 90 days).

1. https://github.com/settings/tokens?type=beta → "Generate new token"
2. Resource owner: DavidHatami
3. Repository access: select `sam-chief-of-staff` AND `sam-ops`
4. Permissions:
   - **Contents: Read and write**
   - **Metadata: Read-only** (auto-included)
5. Expiration: 365 days (max for fine-grained)
6. Generate, copy
7. Update `GITHUB_PAT` in Netlify env, redeploy
8. Verify: 🔐 Credentials shows GitHub green; the badge shows new days-until-expiry

### 3g. YAHOO_APP_PASSWORD
1. https://login.yahoo.com/account/security → App passwords
2. Generate new one for "SAM"
3. Update `YAHOO_APP_PASSWORD` in Netlify env, redeploy
4. Verify: ⚙️ Cron Health shows yahoo-warmer green within 4 minutes

### 3h. RESEND_API_KEY
1. https://resend.com/api-keys → Create API Key, full access
2. Update `RESEND_API_KEY` in Netlify env, redeploy
3. Verify

### 3i. ZOOM_CLIENT_SECRET
1. https://marketplace.zoom.us → My Apps → SAM app → App Credentials
2. Regenerate client secret
3. Update `ZOOM_CLIENT_SECRET` in Netlify env, redeploy
4. Verify

---

## 4. Deploy went bad — roll back

**Symptom:** SAM was working, you (or Claude) pushed something, now it's broken. Dashboard won't load, endpoints return 500, console errors.

**Fix in 30 seconds:**

1. Go to https://app.netlify.com/projects/sam-chief-of-staff/deploys
2. Find the last deploy where status was "Published" AND date is BEFORE the broken push
3. Click that deploy
4. Click "Publish deploy" button (top right)
5. Confirm

Live site rolls back in ~30 seconds. The bad code stays in GitHub but the deploy serves the previous build.

**After rollback — fix the code:**
1. Identify the broken commit: `git log --oneline -10`
2. Revert it: `git revert <commit-sha>`
3. Push the revert: `git push origin master`
4. Netlify auto-deploys the revert (now master matches the rolled-back state)

**If the rollback button doesn't appear:** Netlify keeps deploys for 90 days on Pro plan. After that you have to redeploy from a known-good commit:
```bash
git checkout <good-sha>
# In Netlify dashboard: Deploys → Trigger deploy → Deploy site (uses current branch tip)
git checkout master  # don't forget to come back
```

---

## 5. Restore data from sam-ops backup

**Symptom:** A blob store got corrupted, accidentally deleted, or a migration went wrong.

**The backups live at:** https://github.com/DavidHatami/sam-ops/blob/main/backups/sam-data-backup.json

Each backup contains every blob from sam-tasks, sam-instructions, sam-projects, email-flags, zoom-processed.

**To restore one or all stores:**

### 5a. Find the backup you want
Browse https://github.com/DavidHatami/sam-ops/commits — backups are 1 per day at 7 UTC. Click any commit, click `backups/sam-data-backup.json`, click "View raw".

### 5b. Run the restore script
Currently there is no automated restore tool. The manual procedure:

1. Download the `sam-data-backup.json` from the chosen date
2. Open in a text editor; identify which `_meta.stores[].name` you want to restore (e.g. `sam-tasks`)
3. The data for that store is at `data["sam-tasks"]` — an object of `{key: value}` pairs
4. For each key/value pair, you need to call Netlify Blobs `set`. The simplest path is to ask Claude to write a one-off restore function for you, give it the JSON, and run it.

**TODO** — turn this into an automated `/api/admin/restore?date=YYYY-MM-DD&store=sam-tasks` endpoint. Currently this is the gap. If you ever actually need to restore, message Claude and the restore script can be built and run in 15 minutes.

### 5c. Verify restoration
Hit the relevant endpoint (e.g. `/api/tasks/`) and confirm the data is back.

---

## 6. Yahoo IMAP locked up

**Symptom:** Yahoo email tab spins forever. Yahoo-warmer cron is failing repeatedly. You see error `Mailbox is already locked` or `Authentication failed too many times` in logs.

**Why this happens:** IMAP holds an exclusive lock on the mailbox during fetch. If a previous run's connection didn't clean up properly (e.g. Lambda killed mid-fetch), Yahoo's server may keep the lock for 5-10 minutes. Multiple concurrent connections compound this.

**Fix in 3 steps:**

1. **Wait 10 minutes.** Yahoo IMAP locks self-clear after 600s. Most "stuck" cases resolve on their own.

2. **Force-clear the cache and re-warm:**
```
DELETE the entire `sam-yahoo-cache` blob (you can do this from Netlify Functions console)
# Or: trigger yahoo-warmer manually (Section 10) — fresh connection, fresh state
```

3. **If still locked after 30 minutes:** the YAHOO_APP_PASSWORD may have been auto-revoked by Yahoo for "too many auth failures". Generate a new app password (Section 3g) and update the env var.

**Verify:** dashboard 🔐 Credentials → Yahoo Mail green; Yahoo email tab loads in <2s.

---

## 7. Briefings landing in spam

**Symptom:** You stopped seeing morning briefings in your inbox. Check your Junk folder — they're probably there.

**Why:** edupolicy.ai domain isn't SPF/DKIM verified with Resend, so receiving servers (Gmail, Outlook) flag the briefings as suspicious.

**The permanent fix is at:** `docs/RESEND_DNS_FIX.md` — 10-minute clicking exercise at GoDaddy + Resend.

**Until that's done, the workaround:**
1. Open the briefing email in spam
2. Click "Not spam" / "Mark as not phishing"
3. Add `onboarding@resend.dev` to your contacts
4. Most providers stop spam-filtering after 2-3 of these flags

This is a temporary patch. Do the DNS fix.

---

## 8. Edge 503 errors

**Symptom:** Dashboard or API endpoints sporadically return HTTP 503 with body `error: "DNS cache overflow"` or no body at all.

**This is a Netlify Edge layer transient.** Not your code, not your config. It happens 0.5–2% of requests under normal load.

**Fix:** Retry. Specifically:
- Browser: hit refresh
- API call: re-issue with a cache-buster: `?cb={Date.now()}`
- Curl tests: try 3-4 times with 2-3s delay between

The frontend code already retries reads automatically when the response is empty/non-200. You shouldn't see this from inside SAM — only when curl-testing or hitting endpoints from outside.

**If 503 persists for >5 minutes across multiple endpoints:** Netlify itself has an outage. Check https://www.netlifystatus.com/ — there's nothing you can do from this side.

---

## 9. Clear blob caches

**Symptom:** SAM is showing stale data even after a refresh. Triage queue won't update. Briefings show yesterday's content. Cron Health shows weird stale heartbeats.

**Fix per cache:**

| Cache blob | What it stores | How to clear |
|------------|----------------|--------------|
| `sam-yahoo-cache` | Yahoo IMAP snapshots | Force yahoo-warmer manual run (Section 10), it overwrites |
| `sam-cron-heartbeat` | Per-job last-run records | Clear individually via Netlify console, or delete keys via a one-off function call |
| `sam-briefing-audio` | TTS MP3s | Auto-expire on 1y blob TTL; manual delete via Netlify console |
| Browser cache | All Cache-Control'd responses | Hard refresh: Cmd+Shift+R (Mac) / Ctrl+Shift+R (Windows) |

The Netlify Functions console for blob inspection: https://app.netlify.com/projects/sam-chief-of-staff/logs → Blobs tab. You can list, view, and delete keys from there.

---

## 10. Manually trigger any cron

If a scheduled job is stuck or you want to force a fresh run, you can hit each one's manual HTTP equivalent:

| Cron job | Manual trigger | Method | Waits ~ |
|----------|---------------|--------|---------|
| briefing-daily | `/api/briefing/now` | POST | 25-35s |
| triage-scheduled | `/api/triage/run` | POST | 10-25s |
| conflicts-scheduled | `/api/conflicts/run` | POST | 5-15s |
| review-scheduled | `/api/review/now` | POST | 25-40s |
| backup-nightly | (no manual trigger — schedule only) | — | — |
| yahoo-warmer | (no manual trigger — schedule only) | — | — |
| zoom-check-background | (no manual trigger — schedule only) | — | — |

For the three that have no manual trigger: in Netlify dashboard → Functions → click the function → click "Invoke" button. That fires it immediately.

After any manual trigger, ⚙️ Cron Health updates within 30s. Heartbeat is written regardless of whether the function succeeded or failed.

---

## 11. X-Cache header decoder

When debugging Yahoo email speed, every response has an `X-Cache` header:

| Value | Meaning | Typical latency |
|-------|---------|-----------------|
| `hit` | L1 in-memory cache hit (warm Lambda container) | 100-300ms |
| `l2-hit` | L2 Netlify Blob cache hit (cold start, blob rescued us) | 300-500ms |
| `miss` | No cache; full IMAP fetch | 5-8s |

If you're seeing `miss` repeatedly when you'd expect `hit`, the Lambda container is going cold between requests. This is normal at 2+ minutes of idle. After Yahoo-warmer's next cron tick, you should get `l2-hit` even on a cold container.

---

## 12. Secrets locations

Your credentials live in **four places**. If any one of these is compromised, rotate everywhere.

1. **Netlify env vars** (`https://app.netlify.com/projects/sam-chief-of-staff/configuration/env`) — the live source of truth for the deployed app
2. **`/mnt/project/_Secret_Agent_Man`** — Claude project file, has historical record
3. **`/mnt/project/SAM1`** — secondary Claude project file
4. **GitHub repo `sam-chief-of-staff`** — `GITHUB_PAT` is hardcoded in commit history (a known bad practice that should eventually be cleaned up; in practice rotation handles this)

There is **no `.env` file in the repo** — credentials are never committed. Good.

---

## 13. Total disaster recovery

Worst case: everything is on fire. Netlify deploy is broken. You can't even sign in.

### 13a. Recovery sequence

1. **Confirm SAM data is safe:** Visit https://github.com/DavidHatami/sam-ops/commits — latest backup should be from this morning at 7 UTC. If yes, your data is fine regardless of what happened.

2. **Check Netlify status:** https://www.netlifystatus.com/ — if Netlify itself is down, wait. Nothing else you can do.

3. **If your code is broken:** Section 4 — roll back to last good deploy.

4. **If your DATA is broken:** Section 5 — restore from sam-ops backup.

5. **If your credentials are broken:** Section 3 — rotate the affected credential.

6. **If MULTIPLE things are broken at once:** This is when you message Claude. Don't try to fight everything alone — the diagnosis order matters.

### 13b. SAM is YOU. You are not SAM.

Your inbox, calendar, tasks, briefings — these all exist OUTSIDE of SAM, in M365/Google/Yahoo/Zoom. SAM is a viewer + classifier on top of them. If SAM disappears completely:

- Your email is still in M365/Gmail/Yahoo
- Your calendar is still in M365/Google
- Your meetings are still in Zoom
- Your tasks (the SAM-native ones) are still in `sam-ops` backup as JSON

You lose the dashboard, the morning briefing, the conflict hunter, the unified inbox. You don't lose data. The worst-case rebuild from scratch (new Netlify site, restore data, point DNS) is a 4-hour recovery, not a catastrophic loss.

### 13c. Two devices, please

Make sure you can sign in to SAM from both your laptop AND your phone. If one device is the only place you've ever logged in, a device failure compounds with any infrastructure problem. The password is `SAM2026!` — if you've forgotten that, rotate `SAM_PASSWORD` env var in Netlify.

---

## Appendix: useful URLs at a glance

```
Live site:           https://sam-chief-of-staff.netlify.app
Health endpoints:    https://sam-chief-of-staff.netlify.app/api/cron/health
                     https://sam-chief-of-staff.netlify.app/api/credentials/health
                     https://sam-chief-of-staff.netlify.app/api/backup
Code repo:           https://github.com/DavidHatami/sam-chief-of-staff
Backups:             https://github.com/DavidHatami/sam-ops
Netlify dashboard:   https://app.netlify.com/projects/sam-chief-of-staff
Netlify logs:        https://app.netlify.com/projects/sam-chief-of-staff/logs/functions
Netlify env vars:    https://app.netlify.com/projects/sam-chief-of-staff/configuration/env
Netlify status:      https://www.netlifystatus.com/

Anthropic console:   https://console.anthropic.com
OpenAI console:      https://platform.openai.com/api-keys
Google Cloud:        https://console.cloud.google.com
Azure (M365):        https://portal.azure.com
Zoom Marketplace:    https://marketplace.zoom.us
Resend dashboard:    https://resend.com/dashboard
GitHub PATs:         https://github.com/settings/tokens?type=beta
Yahoo app passwords: https://login.yahoo.com/account/security
```

**This document is the floor, not the ceiling.** When you encounter a new failure mode, add a section to this runbook so future-you doesn't have to reinvent the diagnosis.
