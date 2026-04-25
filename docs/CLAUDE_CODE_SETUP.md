# Claude Code on SAM — Setup Guide for Dr. Hatami

You're going to install Claude Code on your Mac, sign in with your Pro Max account, pull SAM down from GitHub, and start editing the real code from your laptop. Every command below is copy-paste. Total time: about ten minutes.

A few honest notes before we start.

Claude Code runs in Terminal. I know — you don't love Terminal. But you'll only need it to launch Claude Code. Once `claude` is running, you talk to it in plain English the same way you talk to me here. It just happens to be sitting on your laptop with full access to SAM's actual files instead of working blind through chat.

Your Pro Max subscription covers this. No separate API key needed. No new billing.

The native installer is the right choice for you. It doesn't need Node.js, doesn't need Homebrew, and it auto-updates itself in the background so you don't have to think about versions. The other install methods (Homebrew, npm) require you to run upgrade commands manually. Skip those.

---

## Step 1 — Install Claude Code

Open Terminal. Cmd+Space, type "Terminal", hit Return.

Paste this single line and hit Return:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Wait for it to finish. You'll see download progress, then "Installation complete." When it's done, close Terminal entirely and open a fresh window. This matters — the new window picks up the updated PATH so the `claude` command works.

In the fresh Terminal window, verify the install:

```bash
claude --version
```

You should see a version number print out. If you see "command not found," paste this and try again:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
claude --version
```

That tells your shell where the binary lives. Should work after that.

---

## Step 2 — Sign in with your Pro Max account

In Terminal, run:

```bash
claude
```

Your browser opens to a Claude sign-in page. Sign in with the same credentials you use at claude.ai — the Pro Max account. The browser will say "authenticated" and tell you to return to Terminal. Go back to Terminal and you're now sitting inside Claude Code. You'll see a prompt waiting for input.

Type `/exit` and hit Return to leave for now. We'll come back here once SAM is on your laptop.

---

## Step 3 — Get SAM onto your laptop

In Terminal, make a folder for development work and pull SAM down from GitHub:

```bash
mkdir -p ~/dev
cd ~/dev
git clone https://github.com/DavidHatami/sam-chief-of-staff.git
cd sam-chief-of-staff
```

When git asks for credentials on the clone, your username is `DavidHatami` and the password is your GitHub PAT (the one stored in your project notes — `github_pat_11BS3FTVA0lc...`). After you enter it once, macOS keychain remembers it, and you won't be prompted again on this machine.

Quick sanity check — make sure you got the real repo:

```bash
ls
```

You should see `index.html`, a `netlify` folder, `package.json`, and friends. That's SAM.

---

## Step 4 — Drop a CLAUDE.md into the repo

This is the step most guides skip and the one that actually matters. CLAUDE.md is a project-level briefing document. Every time Claude Code opens this folder, it reads CLAUDE.md first and operates accordingly. Without it, you're going to spend the first twenty minutes of every session re-explaining your rules. With it, Claude Code already knows.

I've written one for SAM that bakes in everything we've learned. Run this command from inside the `sam-chief-of-staff` folder to create it:

```bash
cat > CLAUDE.md << 'CLAUDE_MD_EOF'
# SAM (Secret Agent Man) — Project Brief for Claude Code

## What this is
SAM is Dr. Hatami's personal Chief of Staff dashboard. Live at sam-chief-of-staff.netlify.app. Single-page app at index.html (~200KB), 17 Netlify serverless functions in `netlify/functions/`, 10 UI tabs (Dashboard, Email, Calendar, Tasks, Zoom, Events, Projects, AI Workbench, Scheduling, Integrations).

## Hard rules — never violate
- ONLY repo is DavidHatami/sam-chief-of-staff. Never create new repos.
- ONLY branch is master. Commit directly to master. Never create feature/*, claude/*, dev/*, or hotfix/* branches.
- Never open PRs. Push to master.
- sam-ops is the backup repo only. Never push code there.

## Deploy chain
- `git push origin master` triggers Netlify auto-deploy. ~30 seconds to live.
- After every push, verify the deploy succeeded before claiming the work is done.

## Operating principles
- One change → commit → push → verify live → next change. Never stack three edits, push them together, and hope.
- `git commit` before each meaningful edit so rollback is surgical, not nuclear.
- Test locally when feasible before pushing to production.
- DOM edits to index.html via Python string manipulation are forbidden. The file is too large and too critical. Use targeted str_replace edits, never regex sweeps that touch the whole document.
- No new feature without a clear time-saving justification. If it's cosmetic, don't build it.

## Current technical IDs
- Netlify site ID: cf562241-66f2-4314-872c-e42a8ca5ef62
- AI engines wired in: claude-opus-4-6, gpt-5.4, gemini-2.5-flash
- Email accounts: M365 (admin@edupolicy.ai), Gmail (dh30111@gmail.com), Yahoo (dh30111@yahoo.com — IMAP proxy pending)
- Calendar: dual-write to M365 + Google Calendar
- Storage: Netlify Blobs
- Email send: Resend

## Netlify Functions notes that bite
- `config.path` must use array format like `["/api/tasks", "/api/tasks/*"]`. Wildcard-only fails to match the root route.
- `GOOGLE_REFRESH_TOKEN` is a protected namespace on Netlify — use `G_REFRESH_TOKEN` instead.
- Tokens containing `//` can break MCP tools. Set them directly via the Netlify API and verify with `getAllEnvVars`.
- Gmail API: normalize the `from` field from Gmail's raw string into M365 object format `{emailAddress: {name, address}}` before returning, or the shared frontend reply logic breaks.

## How Dr. Hatami works
- Direct, execution-focused. Doesn't want commentary on scope or feasibility.
- Non-coder. Don't dump unexplained jargon. Don't ask him to read code.
- Stop telling him to finish jobs he asked you to do.
- Honest reporting only. If something didn't ship, say so. Don't pretend a half-finished commit is done.

## Known pending items
- GoDaddy email forwarding for dhatami@edupolicy.ai
- Council synthesis timeout fix (Council Mode times out during 3-engine synthesis step)
- Grok addition planned (4th AI engine)
- Yahoo IMAP proxy (no REST API exists)

## Roadmap (8 weeks from April 23, 2026)
- P1 AGENCY: morning briefing engine, email triage agent, calendar conflict hunter, transcript-to-tasks
- P2 SYNTHESIS: unified inbox, client context pages, weekly review, cross-ref vector search
- P3 MEMORY: persistent AI context, writing voice model, relationship cards, decision log
- P4 UBIQUITY: SMS via Twilio, Web Push, voice briefings via TTS, Telegram bot
CLAUDE_MD_EOF
```

Now commit it and push:

```bash
git add CLAUDE.md
git commit -m "Add CLAUDE.md project brief for Claude Code"
git push origin master
```

That's the briefing document. It now lives in the repo permanently, and any Claude Code session — yours, mine if I clone the repo, anyone's — picks it up automatically.

---

## Step 5 — Run Claude Code on SAM

From inside the `sam-chief-of-staff` folder, launch:

```bash
claude
```

Claude Code starts up. It reads CLAUDE.md silently. Now you're talking to a Claude that has full file access to SAM's real codebase. Ask it anything:

```
what's broken on the calendar tab right now?
```

```
add a search bar to the email tab
```

```
fix the council synthesis timeout
```

It will read the relevant files, make edits, and ask you before committing. Type `/exit` when you're done. Your session ends, your changes stay in the repo, you can resume next time with `claude --continue`.

---

## Daily usage — the short version

Open Terminal. Then:

```bash
cd ~/dev/sam-chief-of-staff
claude
```

That's it. Two lines and you're back in. To resume a previous conversation:

```bash
claude --continue
```

To pick a different past session:

```bash
claude --resume
```

To check that everything's healthy:

```bash
claude doctor
```

---

## A few things worth knowing

**Plan mode** — hit Shift+Tab inside Claude Code to make it propose an approach before touching files. Useful when you're about to ask for something risky and you want to see the plan before the edits start. Hit Shift+Tab again to exit plan mode.

**Slash commands** — type `/` for a list. The ones you'll actually use: `/help`, `/status` (shows your auth and rate limit), `/model` (switches between Sonnet and Opus), `/exit`.

**Model choice** — by default Claude Code uses Sonnet for speed. For heavy SAM surgery (rebuilding a function, refactoring a tab, debugging a chained failure), switch to Opus mid-session with `/model`. Then switch back to Sonnet for routine edits. Opus burns more of your Pro Max quota but thinks deeper.

**The VS Code extension** — optional. If you ever want a graphical view of the files alongside the Claude Code conversation, install VS Code from code.visualstudio.com, then add the Claude Code extension from inside VS Code. Same authentication, same conversations, same CLAUDE.md. Skip it for now if Terminal is enough.

---

## What this changes about how we work

Right now, when you ask me to fix something in SAM, I read the file, make an edit, push, and we hope. Claude Code on your Mac reads the whole repo every session, runs your code locally, runs `git status` and `git diff` before deciding anything, and surfaces the actual error messages from `npm run` instead of guessing at what broke.

Stop pasting code into Claude.ai chat. Start running `claude` in the repo and asking it directly. The conversation quality goes up, the cycle time drops, and the surprise-failure rate falls hard.

When something breaks on production, this is the workflow:

```bash
cd ~/dev/sam-chief-of-staff
git pull origin master
claude
```

Then tell Claude Code what's broken. It investigates, fixes, commits, pushes, and you watch Netlify go green.

That's the whole setup. Go run Step 1.
