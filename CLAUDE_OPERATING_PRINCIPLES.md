# Operating Principles for Future Claudes Working on SAM

This document is for any Claude session picking up SAM development. It captures principles
learned the hard way that don't belong in code comments. Read this before claiming any work
is "done."

## 1. Verify by reading back, or don't claim success

**The single most important principle on this codebase.**

A 200 status code from a sending API means "we accepted your request." It does NOT mean:
- The email arrived in the recipient's inbox
- The calendar invite reached the attendee
- The Zoom meeting is visible in the host's account
- The task is queryable from the listing endpoint
- The message was actually delivered (vs. queued, bounced, spam-filtered, or silently dropped)

**Failure mode this prevents:** declaring "tool chain works" because Resend returned `{success: true, emailId: "..."}` when in fact the recipient address was nonexistent, the message was rejected by the receiving server, and nothing was delivered. This actually happened in the Phase 4 ship session (April 25, 2026) — David caught it.

**The principle:** when the work matters (real email to real person, real calendar invite, real money, real commitment), the test or the operation is incomplete until you have READ THE RESULT BACK from the destination system. Send + verify-by-reading-back, or don't claim success.

**In code:** SAM's tool-use prompt has been updated with this rule. Hard-gated E2E tests must include a read-back step for any operation that crosses a system boundary.

**For future sessions:** if you're tempted to call a test "passing" because the API returned 200, stop. Ask yourself: did I read the result back from the destination? If no, the test is incomplete.

## 2. One change → push → verify live → next change

Cascading fixes break things in unpredictable ways. When something is broken in production, fix
ONE thing, push it, watch the deploy gate go green, THEN move to the next thing. Never ship a
batch of three fixes and hope they all land. (Learned April 15, 2026.)

The exception is when changes are genuinely interdependent — a new endpoint plus the frontend
that calls it, for example. Those need to ship together. But "let me also fix this unrelated
thing while I'm here" is the path to a broken weekend.

## 3. The repo is one repo, the branch is master

`DavidHatami/sam-chief-of-staff` is the only repo for code. `master` is the only branch — direct
commits, no PRs, no `claude/*` branches, no `feature/*` branches. `sam-ops` and `SAM-ops1`
receive nightly auto-backups and that's all they're for.

If a tool tries to create a branch named `claude/<something>`, that's a bug — fix the tool, don't
work around it.

## 4. Banned phrases when memory is empty

When SAM has no standing knowledge for a topic and no semantically-relevant past conversation,
SAM must NOT say:
- "already on file"
- "you told me before"
- "I have it tracked"
- "filed earlier"
- "we discussed this"

These phrases without a corresponding memory section are fabrication. The system inserts an
explicit `[NO PRIOR MEMORY MATCHED]` sentinel when both sections are empty; SAM is required to
respect it.

## 5. Don't touch production data without sign-off

If SAM finds malformed data in a blob, a corrupt task entry, an inconsistent state — flag it,
don't silently fix it. The user gets to decide whether the cleanup is OK to run. The exception
is operations explicitly authorized by the system design (e.g. nightly backups, scheduled
distillations) where the user has pre-authorized the action.

When in doubt: surface the finding, propose a fix, wait for sign-off.

## 6. The "ALWAYS and FOREVER" trap

David sometimes phrases asks with absolute language: "anticipate what I want ALWAYS and FOREVER,"
"never miss," "make SAM smarter than me." These are aspirational, not literal contracts.
Acknowledging them as literal commitments is yes-man behavior — you'll fail, and worse, you'll
fail by quietly degrading instead of admitting the limit. Push back honestly on absolute
language, then build toward the spirit of the ask within real constraints.

A well-engineered anticipations layer that produces 5 specific nudges based on real data is
worth ten times more than a system that promises omniscience and produces noise to look like
it's working.

## 7. Talk straight, no padding

David has explicit voice rules in his preferences (banned word list, sentence-length variance,
no parallelism, contractions mandatory, opinions stated as fact). Apply these to ALL output —
chat replies, commit messages, summaries, postmortems. The list is long but enforced.

The most violated banned words in this codebase historically: "comprehensive," "robust,"
"leverage," "navigate," "framework" (used as metaphor), "foster," "delve." If you find yourself
typing one, rewrite.

## 8. Memory is what's in the context, not what's in your head

Future Claudes won't remember this session. They'll see this file, the userMemories block, the
codebase, and any compaction summary. Anything important about HOW SAM should behave belongs in
one of those three places — not in a parenthetical that gets lost on the next compaction.

If a principle is worth following, it's worth writing down here.
