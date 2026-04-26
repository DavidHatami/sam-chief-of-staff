# SAM End-to-End Tests

## Files

- **`e2e_phased.py`** — The hard-gated phased E2E. 9 phases, ~70 gates, snapshot/restore around state-mutating tests so production data is never destroyed.

## Running

```bash
export GITHUB_TOKEN=ghp_yourTokenHere    # for Phase 8 (private repo file checks)
python3 tests/e2e_phased.py
```

Exit code is `0` if all gates pass, `1` if any fail.

## Phases

| Phase | What it tests |
|---|---|
| 1. PRE-FLIGHT | Snapshot memory + chat-history + anticipations to local; verify all 13 public endpoints return 200 |
| 2. AUTHENTICATION | Each of 9 external services (Claude, OpenAI, Gemini, M365, Google, Zoom, Resend, GitHub, Yahoo) authenticates within latency budget |
| 3. DATA INTEGRITY | Tasks blob has zero malformed entries, memory schema is valid, all 9 cron jobs registered |
| 4. TOOL USE | Single-tool task lifecycle (create → verify → delete → verify gone); multi-tool email chain with REAL delivery verified by polling Gmail inbox |
| 5. MEMORY | Seed unique person via chat → distill → verify in standing knowledge → fresh-process recall query → restore baseline via PUT |
| 6. ANTICIPATIONS | Generate ≥3 anticipations, verify each is specific (real numbers/dates/proper nouns, not generic platitudes) |
| 7. FRONTEND | All cards on correct tabs, refresh buttons wrapped in btnFeedback helper |
| 8. PRINCIPLES | CLAUDE_OPERATING_PRINCIPLES.md exists in repo with verify-by-reading-back rule; BASE_PROMPT in ai.mts contains both rules |
| POST | Verify snapshot restored, no test data leaked into production |

## Hard-gate rules

A "hard gate" is a binary check with explicit YES/NO evidence. No partial credit. The whole E2E only passes if every gate passes.

The E2E is designed to NEVER destroy production data. Every test that mutates state snapshots first and restores at the end. This was a fix after a prior version of the E2E wiped real standing knowledge during testing. See `CLAUDE_OPERATING_PRINCIPLES.md` for the principle.

## Verify-by-reading-back

Phase 4.2 is the canonical example: SAM sends an email via Resend (200 from sender API), but the test is NOT considered passing until the message is found in the recipient's inbox by polling SAM's own Gmail integration. A 200 from a sender means "queued," not "delivered."

This pattern applies anywhere a tool action crosses a system boundary: send + verify-by-reading-back, or don't claim success.
