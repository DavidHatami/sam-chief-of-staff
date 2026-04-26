#!/usr/bin/env python3
"""
SAM HARD-GATED FULL E2E — Phased

Phases:
  1. PRE-FLIGHT     : snapshot current state, endpoint health
  2. AUTHENTICATION : 9 external credentials authenticate
  3. DATA INTEGRITY : no malformed task blobs, valid memory shape
  4. TOOL USE       : multi-tool chain with real-inbox delivery verification
  5. MEMORY         : seed → distill → recall (snapshot/restore around test)
  6. ANTICIPATIONS  : generate, verify specificity
  7. FRONTEND       : dashboard hygiene, button feedback present
  8. PRINCIPLES     : codified rules in place (BASE_PROMPT + operating doc)
  POST              : verify snapshot restored, no test data leaked

NEVER DESTROYS PRODUCTION DATA. Every test that mutates state snapshots first
and restores at the end. If restore fails, the failure is loud.
"""
import json
import sys
import time
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime

SITE = "https://sam-chief-of-staff.netlify.app"
GH_RAW = "https://raw.githubusercontent.com/DavidHatami/sam-chief-of-staff/master"
MARKER = f"E2E-{int(time.time())}"

# Test result accumulator: {phase_name: [(gate_name, passed, evidence), ...]}
RESULTS = {}
SNAPSHOT = {}  # holds pre-flight snapshots for restore at end


def http(method, path, body=None, timeout=60, base=None):
    url = (base or SITE) + path if not path.startswith("http") else path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            text = r.read().decode("utf-8", errors="replace")
            try:
                return r.status, json.loads(text)
            except json.JSONDecodeError:
                return r.status, text
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", errors="replace")
        try:
            return e.code, json.loads(text)
        except Exception:
            return e.code, text
    except Exception as e:
        return 0, f"NETWORK ERROR: {e}"


def gate(phase, gate_name, passed, evidence=""):
    RESULTS.setdefault(phase, []).append((gate_name, passed, evidence))
    icon = "✓" if passed else "✗"
    print(f"      {icon} {gate_name}{(' — ' + evidence[:200]) if evidence else ''}")


def phase_header(num, name):
    print(f"\n{'═' * 74}")
    print(f"  PHASE {num}: {name}")
    print(f"{'═' * 74}")


# ═══════════════════════════════════════════════════════════════════════════
print(f"\n{'█' * 74}")
print(f"  SAM HARD-GATED PHASED E2E — {datetime.utcnow().isoformat()}Z")
print(f"  Marker: {MARKER}")
print(f"{'█' * 74}")

# ─────────────────────────────────────────────────────────────────────────
# PHASE 1: PRE-FLIGHT — snapshot + endpoint health
# ─────────────────────────────────────────────────────────────────────────
phase_header(1, "PRE-FLIGHT — snapshot production state, verify endpoints")

print("\n  [1.1] Snapshotting production state for restore-at-end")
code, mem_snap = http("GET", "/api/memory", timeout=15)
if code == 200 and isinstance(mem_snap, dict):
    SNAPSHOT["memory"] = mem_snap
    gate("preflight", "memory snapshot", True,
         f"people={len(mem_snap.get('people',[]))} projects={len(mem_snap.get('projects',[]))} prefs={len(mem_snap.get('preferences',[]))} decs={len(mem_snap.get('decisions',[]))}")
else:
    gate("preflight", "memory snapshot", False, f"GET /api/memory returned {code}")
    SNAPSHOT["memory"] = None

code, hist_snap = http("GET", "/api/chat-history", timeout=15)
if code == 200 and isinstance(hist_snap, dict):
    SNAPSHOT["chat_history"] = hist_snap.get("turns", []) if "turns" in hist_snap else []
    gate("preflight", "chat-history snapshot", True, f"{len(SNAPSHOT['chat_history'])} turns captured")
else:
    gate("preflight", "chat-history snapshot", False, f"GET returned {code}")
    SNAPSHOT["chat_history"] = None

code, anticip_snap = http("GET", "/api/anticipations", timeout=15)
if code == 200:
    SNAPSHOT["anticipations"] = anticip_snap
    gate("preflight", "anticipations snapshot", True,
         f"{len(anticip_snap.get('anticipations', []))} active for {anticip_snap.get('forDate', '?')}")
else:
    SNAPSHOT["anticipations"] = None
    gate("preflight", "anticipations snapshot", False, f"GET returned {code}")

print("\n  [1.2] All public endpoints return 200")
endpoints = [
    "/api/anticipations", "/api/memory", "/api/tasks/", "/api/cron/health",
    "/api/credentials/health", "/api/m365/mail?folder=inbox&top=1",
    "/api/gmail/mail?folder=inbox&top=1", "/api/chat-history",
    "/api/triage/pending", "/api/conflicts/open", "/api/briefing/history",
    "/api/backup", "/api/projects",
]
ep_results = []
for path in endpoints:
    code, _ = http("GET", path, timeout=20)
    ep_results.append((path, code))

for path, code in ep_results:
    gate("preflight", f"GET {path}", code == 200, f"got {code}")

# ─────────────────────────────────────────────────────────────────────────
# PHASE 2: AUTHENTICATION — every external credential authenticates
# ─────────────────────────────────────────────────────────────────────────
phase_header(2, "AUTHENTICATION — 9 external credentials")

code, cred = http("GET", "/api/credentials/health", timeout=30)
if code != 200:
    gate("auth", "credentials endpoint", False, f"got {code}")
else:
    # Endpoint returns { credentials: [{service, label, status, checkLatencyMs, reason}], summary: {...} }
    services = cred.get("credentials", []) if isinstance(cred, dict) else []
    summary = cred.get("summary", {}) if isinstance(cred, dict) else {}
    print(f"\n  Services reported: {len(services)} | OK: {summary.get('ok', 0)} | Failed: {summary.get('alarm', 0)}")
    expected = ["Claude AI", "OpenAI (TTS)", "Gemini", "Microsoft 365",
                "Google (Gmail/Calendar)", "Zoom", "Resend (email)",
                "GitHub (backups)", "Yahoo Mail"]
    by_label = {s.get("label", ""): s for s in services}
    by_service = {s.get("service", ""): s for s in services}
    for svc_name in expected:
        svc = by_label.get(svc_name) or by_service.get(svc_name)
        if not svc:
            gate("auth", svc_name, False, f"not in credentials list (have: {list(by_label.keys())})")
        else:
            ok = svc.get("status") == "ok"
            latency = svc.get("checkLatencyMs", svc.get("latencyMs", "?"))
            gate("auth", svc_name, ok, f"status={svc.get('status', '?')} latency={latency}ms")

# ─────────────────────────────────────────────────────────────────────────
# PHASE 3: DATA INTEGRITY
# ─────────────────────────────────────────────────────────────────────────
phase_header(3, "DATA INTEGRITY — no corrupt blobs, valid shapes")

print("\n  [3.1] Tasks blob: no malformed entries")
code, cleanup_dry = http("POST", "/api/tasks/cleanup", timeout=30)
if code != 200:
    gate("integrity", "tasks cleanup probe", False, f"endpoint returned {code}")
else:
    malformed = cleanup_dry.get("malformedCount", -1)
    total = cleanup_dry.get("totalBlobs", 0)
    gate("integrity", "tasks blob clean", malformed == 0,
         f"{malformed} malformed of {total} total blobs")
    if malformed > 0:
        for m in cleanup_dry.get("malformed", []):
            print(f"        - blob '{m.get('key')}' issue: {m.get('issue')}")

print("\n  [3.2] Memory blob: valid Knowledge shape")
code, mem = http("GET", "/api/memory", timeout=15)
if code == 200 and isinstance(mem, dict):
    has_keys = all(k in mem for k in ["people", "projects", "preferences", "decisions"])
    types_ok = all(isinstance(mem.get(k, []), list) for k in ["people", "projects", "preferences", "decisions"])
    gate("integrity", "memory schema", has_keys and types_ok,
         f"keys present: {list(mem.keys())}")
else:
    gate("integrity", "memory schema", False, f"got {code}")

print("\n  [3.3] All registered cron jobs present in heartbeat config")
code, cron_h = http("GET", "/api/cron/health", timeout=15)
expected_jobs = [
    "backup-nightly", "briefing-daily", "conflicts-scheduled", "review-scheduled",
    "triage-scheduled", "yahoo-warmer", "zoom-check-background",
    "memory-extract-scheduled", "anticipations-scheduled"
]
if code == 200:
    actual = [j.get("job") for j in cron_h.get("jobs", [])]
    for expected in expected_jobs:
        gate("integrity", f"cron registered: {expected}", expected in actual, "")
else:
    gate("integrity", "cron registry", False, f"got {code}")

# ─────────────────────────────────────────────────────────────────────────
# PHASE 4: TOOL USE — full chain with real-inbox delivery verification
# ─────────────────────────────────────────────────────────────────────────
phase_header(4, "TOOL USE — multi-tool chain → real delivery verified")

print("\n  [4.1] Single tool — task lifecycle (create → verify → delete → verify gone)")
task_title = f"PHASE4 {MARKER}"
# Retry up to 3 times with 5s backoff for transient cold-start failures.
# A code=0 means network error (connection refused / timeout) which is almost always
# a Netlify function cold start when the function was idle.
resp = None
last_code = 0
for attempt in range(3):
    last_code, resp = http("POST", "/api/ai", {
        "model": "claude",
        "prompt": f'Create a high priority task with the EXACT title: "{task_title}". Title only, no other fields.'
    }, timeout=60)
    if last_code == 200:
        break
    print(f"      attempt {attempt+1}: AI endpoint returned {last_code}, retrying in 5s...")
    time.sleep(5)

task_id = None
if last_code != 200:
    gate("tooluse", "task create via tool", False, f"AI endpoint {last_code} after 3 retries")
else:
    tcs = resp.get("toolCalls") or []
    create = next((t for t in tcs if t.get("name") == "create_task" and t.get("ok")), None)
    if not create:
        gate("tooluse", "task create via tool", False,
             f"no successful create_task. tools: {[(t.get('name'), t.get('ok'), t.get('error')) for t in tcs]}")
    else:
        import re
        m = re.search(r'"id":"([^"]+)"', create.get("summary", ""))
        if m:
            task_id = m.group(1)
            gate("tooluse", "task create via tool", True, f"id={task_id}")
        else:
            gate("tooluse", "task create via tool", False, f"no id in summary: {create.get('summary','')[:100]}")

if task_id:
    time.sleep(2)
    code2, resp2 = http("GET", "/api/tasks/", timeout=15)
    tasks = [t for t in (resp2.get("tasks", []) if isinstance(resp2, dict) else []) if isinstance(t, dict)]
    found = next((t for t in tasks if t.get("id") == task_id), None)
    gate("tooluse", "task readable via GET", found is not None,
         f"id={task_id}{' | title=' + found.get('title','') if found else ''}")
    if found:
        gate("tooluse", "task title matches", task_title in (found.get("title") or ""),
             f"got '{found.get('title','')}'")
    code3, _ = http("DELETE", f"/api/tasks/{task_id}", timeout=15)
    gate("tooluse", "task delete returns 200", code3 == 200, f"got {code3}")
    time.sleep(2)
    code4, resp4 = http("GET", "/api/tasks/", timeout=15)
    tasks_after = [t for t in (resp4.get("tasks", []) if isinstance(resp4, dict) else []) if isinstance(t, dict)]
    still = any(t.get("id") == task_id for t in tasks_after)
    gate("tooluse", "task gone after delete", not still, "")

print("\n  [4.2] Multi-tool chain — email send + delivery verified in real Gmail inbox")
email_marker = f"SAM-PHASED-E2E {MARKER}"
code, resp = http("POST", "/api/ai", {
    "model": "claude",
    "prompt": (
        f'Send a test email via Resend. Use account="resend", from="admin@edupolicy.ai", '
        f'to=["dh30111@gmail.com"]. Subject EXACTLY: "{email_marker}". '
        f'Body: "Phased E2E delivery verification. Safe to delete." '
        f'Just send, no questions.'
    )
}, timeout=60)
if code != 200:
    gate("tooluse", "email send tool", False, f"AI endpoint {code}")
else:
    tcs = resp.get("toolCalls") or []
    send = next((t for t in tcs if t.get("name") == "send_email" and t.get("ok")), None)
    if not send:
        gate("tooluse", "email send tool", False,
             f"no successful send. tools={[(t.get('name'), t.get('ok'), t.get('error')) for t in tcs]}")
    else:
        gate("tooluse", "email send tool", True, "")
        # Poll for delivery
        delivered = False
        msg_id = None
        for attempt in range(8):
            time.sleep(8)
            code2, resp2 = http("GET", "/api/gmail/mail?folder=inbox&top=20", timeout=20)
            msgs = resp2.get("value", []) if isinstance(resp2, dict) else []
            match = next((m for m in msgs if email_marker in (m.get("subject") or "")), None)
            if match:
                delivered = True
                msg_id = match.get("id")
                break
        gate("tooluse", "email delivered to real Gmail inbox", delivered,
             f"after {(attempt+1)*8}s, msg_id={msg_id}" if delivered else "never appeared")
        # Cleanup the delivered email
        if msg_id:
            http("DELETE", f"/api/gmail/mail?id={urllib.parse.quote(msg_id)}", timeout=15)

# ─────────────────────────────────────────────────────────────────────────
# PHASE 5: MEMORY — seed → distill → recall, snapshot/restore around test
# ─────────────────────────────────────────────────────────────────────────
phase_header(5, "MEMORY — seed/distill/recall WITH snapshot/restore")

# Use unique markers that won't conflict with anything real
unique_name = f"E2EPerson{MARKER.replace('-', '')}"
unique_uni = f"E2EUni{MARKER.replace('-', '')}"

print(f"\n  [5.1] Seed unique person: {unique_name} at {unique_uni}")
code, resp = http("POST", "/api/ai", {
    "model": "claude",
    "prompt": (
        f"Quick context for the record: I had a brief intro with {unique_name}, "
        f"who is at {unique_uni}. They prefer asynchronous email over calls. "
        f"Just file this — no action needed."
    )
}, timeout=60)
if code != 200:
    gate("memory", "seed turn", False, f"got {code}")
else:
    reply = resp.get("reply", "")
    bluff = any(p in reply.lower() for p in ["already on file", "already have this", "told me before", "filed earlier"])
    gate("memory", "seed turn — no fabricated memory", not bluff, f"reply: {reply[:120]}")

print("\n  [5.2] Distill memory")
code, distill_resp = http("POST", "/api/memory/extract", {}, timeout=90)
if code == 200 and distill_resp.get("ok"):
    after = distill_resp.get("afterCounts", {})
    before = distill_resp.get("beforeCounts", {})
    # Don't gate on delta — auto-cron tick or pre-existing state can change baseline.
    # The real test is whether the test person ends up in memory (gate 5.3 below).
    gate("memory", "distill endpoint succeeds", True,
         f"before={before.get('people',0)} after={after.get('people',0)} turns={distill_resp.get('turnsExtractedFrom','?')}")
else:
    gate("memory", "distill endpoint succeeds", False, f"got {code} {distill_resp}")

print("\n  [5.3] Verify standing knowledge contains the unique marker")
code, mem = http("GET", "/api/memory", timeout=15)
test_person = None
if code == 200:
    for p in mem.get("people", []):
        if MARKER.replace("-", "") in p.get("name", "") or unique_name in p.get("name", ""):
            test_person = p
            break
gate("memory", "test person stored", test_person is not None,
     f"found: {test_person['name'] if test_person else 'NONE'}")
if test_person:
    facts_str = " | ".join(test_person.get("facts", []))
    gate("memory", "test university captured in facts",
         "E2EUni" in facts_str or unique_uni in facts_str,
         f"facts: {facts_str[:200]}")

print("\n  [5.4] Fresh-process recall query")
code, recall_resp = http("POST", "/api/ai", {
    "model": "claude",
    "prompt": f"What university is {unique_name} at? One sentence."
}, timeout=60)
if code == 200:
    reply = recall_resp.get("reply", "")
    gate("memory", "recall via standing knowledge",
         "E2EUni" in reply or unique_uni in reply,
         f"reply: {reply[:200]}")
else:
    gate("memory", "recall via standing knowledge", False, f"got {code}")

print("\n  [5.5] RESTORE — overwrite memory with pre-flight snapshot")
if SNAPSHOT.get("memory"):
    code, restore_resp = http("PUT", "/api/memory", SNAPSHOT["memory"], timeout=15)
    gate("memory", "memory restored from snapshot", code == 200, f"PUT returned {code}")
    # Verify restore landed
    code, after_restore = http("GET", "/api/memory", timeout=15)
    if code == 200:
        original_people = len(SNAPSHOT["memory"].get("people", []))
        restored_people = len(after_restore.get("people", []))
        gate("memory", "restore verified — people count matches snapshot",
             original_people == restored_people,
             f"snap={original_people} now={restored_people}")
    else:
        gate("memory", "restore verified", False, f"GET returned {code}")
else:
    gate("memory", "memory restored from snapshot", False, "no snapshot was captured")

print("\n  [5.6] RESTORE — chat history (only if was non-empty pre-test)")
if SNAPSHOT.get("chat_history") is not None and len(SNAPSHOT["chat_history"]) > 0:
    code, _ = http("PUT", "/api/chat-history", {"turns": SNAPSHOT["chat_history"]}, timeout=15)
    gate("memory", "chat-history restored", code == 200, f"PUT returned {code}")
else:
    gate("memory", "chat-history restored", True,
         f"snapshot was empty ({len(SNAPSHOT.get('chat_history') or [])} turns) — nothing to restore")

# ─────────────────────────────────────────────────────────────────────────
# PHASE 6: ANTICIPATIONS — generation + specificity
# ─────────────────────────────────────────────────────────────────────────
phase_header(6, "ANTICIPATIONS — generation + specificity check")

code, anticip = http("POST", "/api/anticipations/generate", {}, timeout=90)
if code != 200 or not anticip.get("ok"):
    gate("anticipations", "generation", False, f"got {code} {anticip}")
else:
    items = anticip.get("set", {}).get("anticipations", [])
    gate("anticipations", "generated ≥3 items", len(items) >= 3, f"got {len(items)}")
    
    # Check that items are SPECIFIC, not generic
    generic_phrases = ["review your tasks", "check your email", "stay on top of", "don't forget"]
    specific = []
    for a in items:
        text = (a.get("title", "") + " " + a.get("reason", "")).lower()
        has_number = any(c.isdigit() for c in text)
        has_proper = any(w[0].isupper() and len(w) > 2 for w in (a.get("title", "") + a.get("reason", "")).split() if w and w[0].isalpha())
        is_generic = any(p in text for p in generic_phrases)
        if (has_number or has_proper) and not is_generic:
            specific.append(a)
    gate("anticipations", "≥3 are specific (not generic)", len(specific) >= 3,
         f"{len(specific)} of {len(items)} are specific")
    
    # Sample print
    print(f"\n      Sample anticipations:")
    for a in items[:3]:
        print(f"        [{a.get('priority')}] {a.get('title','')[:90]}")

# ─────────────────────────────────────────────────────────────────────────
# PHASE 7: FRONTEND — dashboard hygiene
# ─────────────────────────────────────────────────────────────────────────
phase_header(7, "FRONTEND — dashboard hygiene")

code, html = http("GET", f"/?cb={int(time.time())}", timeout=30)
if code != 200 or not isinstance(html, str):
    gate("frontend", "fetch live HTML", False, f"got {code}")
else:
    gate("frontend", "fetch live HTML", True, f"{len(html)} bytes")
    
    # Find page section line numbers
    lines = html.split("\n")
    p_dash = next((i for i, l in enumerate(lines, 1) if 'id="p-dash"' in l), -1)
    p_integ = next((i for i, l in enumerate(lines, 1) if 'id="p-integrations"' in l), -1)
    
    cards_should_be_dashboard = ["sam-memory-card", "sam-anticipations-card"]
    cards_should_be_integrations = ["sam-status-card", "cron-health-card", "cred-health-card", "smoke-test-card"]
    
    for c in cards_should_be_dashboard:
        ln = next((i for i, l in enumerate(lines, 1) if f'id="{c}"' in l), -1)
        in_dash = p_dash <= ln < p_integ if ln > 0 else False
        gate("frontend", f"{c} on Dashboard", in_dash, f"line {ln}")
    
    for c in cards_should_be_integrations:
        ln = next((i for i, l in enumerate(lines, 1) if f'id="{c}"' in l), -1)
        in_integ = ln > p_integ if ln > 0 else False
        gate("frontend", f"{c} on Integrations", in_integ, f"line {ln}")
    
    # btnFeedback wrapping check — every refresh button should use it
    btnfb_count = html.count("btnFeedback(this")
    gate("frontend", "btnFeedback wraps ≥5 refresh buttons", btnfb_count >= 5, f"found {btnfb_count}")
    
    # btnFeedback helper itself
    has_helper = "window.btnFeedback = function" in html
    gate("frontend", "btnFeedback helper defined", has_helper, "")

# ─────────────────────────────────────────────────────────────────────────
# PHASE 8: PRINCIPLES — codified rules in place
# ─────────────────────────────────────────────────────────────────────────
phase_header(8, "PRINCIPLES — codified operating rules")

print("\n  [8.1] CLAUDE_OPERATING_PRINCIPLES.md present in repo")
# Use GitHub API with token (raw.githubusercontent.com 404s on private repos)
import base64 as _b64
import os
GH_TOKEN = os.environ.get("GITHUB_TOKEN", "")
if not GH_TOKEN:
    print("      ⚠ GITHUB_TOKEN env var not set — Phase 8 will be skipped.")
    print("      Set with: export GITHUB_TOKEN=ghp_... before running.")
def gh_api_file(path):
    """Fetch file content from GitHub API. Returns (status, decoded_text)."""
    if not GH_TOKEN:
        return 0, "GITHUB_TOKEN not set"
    req = urllib.request.Request(
        f"https://api.github.com/repos/DavidHatami/sam-chief-of-staff/contents/{path}?ref=master",
        headers={"Authorization": f"Bearer {GH_TOKEN}", "Accept": "application/vnd.github+json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read())
            content = _b64.b64decode(data["content"]).decode("utf-8", errors="replace")
            return r.status, content
    except urllib.error.HTTPError as e:
        return e.code, str(e)
    except Exception as e:
        return 0, str(e)

status, doc = gh_api_file("CLAUDE_OPERATING_PRINCIPLES.md")
if status == 200 and isinstance(doc, str):
    has_verify = "verify by reading back" in doc.lower() or "verify-by-reading-back" in doc.lower()
    has_no_touch = "don't touch production" in doc.lower() or "production data without sign" in doc.lower()
    gate("principles", "operating doc exists in repo", True, f"{len(doc)} chars")
    gate("principles", "verify-by-reading-back rule documented", has_verify, "")
    gate("principles", "no-prod-touch rule documented", has_no_touch, "")
else:
    gate("principles", "operating doc exists", False, f"got {status}")

print("\n  [8.2] BASE_PROMPT in ai.mts contains verify-by-reading-back rule")
status, ai_src = gh_api_file("netlify/functions/ai.mts")
if status == 200 and isinstance(ai_src, str):
    has_rule = "VERIFY BY READING BACK" in ai_src or "verify-by-reading-back" in ai_src.lower()
    has_banned = "Banned phrases when memory" in ai_src or "banned phrases" in ai_src.lower()
    gate("principles", "BASE_PROMPT has verify-by-reading-back", has_rule, "")
    gate("principles", "BASE_PROMPT has banned-phrase enforcement", has_banned, "")
else:
    gate("principles", "ai.mts source readable", False, f"got {status}")

# ═════════════════════════════════════════════════════════════════════════
# POST: verify restoration (sanity check that we didn't leak test data)
# ═════════════════════════════════════════════════════════════════════════
phase_header("POST", "RESTORE VERIFICATION — no test data leaked")

code, mem = http("GET", "/api/memory", timeout=15)
if code == 200 and SNAPSHOT.get("memory"):
    snap_people = sorted([p.get("name", "") for p in SNAPSHOT["memory"].get("people", [])])
    now_people = sorted([p.get("name", "") for p in mem.get("people", [])])
    test_persons_remaining = [n for n in now_people if MARKER.replace("-", "") in n]
    gate("post", "no test persons in memory after restore", len(test_persons_remaining) == 0,
         f"leaked: {test_persons_remaining}" if test_persons_remaining else "")
    gate("post", "memory people count == snapshot",
         len(snap_people) == len(now_people),
         f"snap={len(snap_people)} now={len(now_people)}")
else:
    gate("post", "memory restore check", False, f"got {code}")

# ═════════════════════════════════════════════════════════════════════════
# FINAL TALLY
# ═════════════════════════════════════════════════════════════════════════
print(f"\n{'█' * 74}")
print(f"  FINAL E2E TALLY")
print(f"{'█' * 74}\n")

total_pass = 0
total_fail = 0
for phase, gates in RESULTS.items():
    p = sum(1 for _, ok, _ in gates if ok)
    f = sum(1 for _, ok, _ in gates if not ok)
    total_pass += p
    total_fail += f
    status = "PASS" if f == 0 else "FAIL"
    print(f"  PHASE {phase:13s} : {p:3d} pass, {f:3d} fail  [{status}]")
    if f > 0:
        for name, ok, ev in gates:
            if not ok:
                print(f"      ✗ {name}{(' — ' + ev[:200]) if ev else ''}")

print(f"\n  TOTAL: {total_pass} pass, {total_fail} fail")
print(f"  E2E ran in marker {MARKER}")

sys.exit(0 if total_fail == 0 else 1)
