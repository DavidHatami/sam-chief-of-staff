# Phase 1 — Architecture

This document captures the architectural spine introduced in Phase 1 of the
path-to-2000%-MVP plan. It explains the module layout, the migration
strategy, and the rules new code must follow.

## Goals

1. Stop every future feature from re-inheriting the monolithic
   `innerHTML = html` render pattern that caused Phase 0's flicker, the AI
   chat memory bloat, and the DOM-duplication bugs.
2. Give `public/index.html` a path to become a thin shell — target < 800
   lines — with each page's behavior living in its own module.
3. Put a typed contract between the client and the 18 serverless functions
   so schema drift fails loudly rather than at runtime.

## Constraints

- **No build step.** The existing deployment pipeline is Netlify's static
  publish of `public/` plus bundled functions. Introducing a bundler /
  TypeScript / framework now is not worth the risk. Phase 1 ships as native
  ES modules.
- **Progressive enhancement.** Every scaffolding commit must leave the app
  fully working. Legacy inline code coexists with modules until the
  corresponding page migrates.
- **One page at a time.** No big-bang rewrite. Each page migrates in its
  own commit with Phase-0 regression check green before advancing.

## Module layout

```
public/
  index.html              ← shell; still monolithic during Phase 1, shrinks as pages extract
  js/
    app.js                ← entry point (<script type="module">); exposes window.Sam
    state.js              ← signals + store primitive
    render.js             ← keyed diff-renderer; setText/setAttr/setClass patches
    esc.js                ← HTML escape + JS-attr escape
    toast.js              ← showToast()
    api.js                ← typed fetch client, one named method per endpoint
    render.test.html      ← standalone self-tests for render.js (open in browser)
    pages/
      (empty; each page lands here as it migrates — email.js, tasks.js, ...)

netlify/
  functions/
    _shapes.ts            ← shared request/response types
    *.mts                 ← individual functions; Phase 1 migrates each to import
                            its shapes from _shapes.ts
```

## Module contracts

### state.js

Exports `createSignal(initial)` and `createStore(initial)`. No reactive
framework; just primitives so page modules can share state without
reaching into globals. Subscribers are notified on change via `Object.is`
inequality. Failures in subscriber callbacks are caught and logged rather
than breaking the notifier.

### render.js

Exports `renderList(parent, items, { key, create, update })` — a keyed
diff-renderer. Contract guarantees are enumerated in
`docs/PHASE-0-CONTRACTS.md` §1. Self-tests live at `/js/render.test.html`
and must all pass before any page adopts the renderer.

Also exports `setText / setAttr / setClass` — no-op-if-equal helpers for
in-place attribute patches. These prevent cursor resets in editable fields
and keep class transitions clean.

### esc.js

Extracted HTML-escape (`esc`) and JS-arg escape (`attrJsArg`) helpers.
Identical semantics to the inline versions in `index.html`. `attrJsArg` is
only needed for the remaining inline-onclick attribute callsites; as
those migrate to delegated listeners the helper will become unused.

### toast.js

Extracted `showToast(message, type, opts)`. Matches the inline version's
behavior — same colors, same 5 s auto-hide — but backed by a single
lazily-created fixed-position container with stacking.

### api.js

One named method per endpoint. Every method:

1. Uses a real route (single source of truth — no more 71 raw `fetch()`
   callsites to audit).
2. Checks `r.ok` before treating the response as success.
3. Returns a normalized `{ ok, status, data, error? }` discriminated
   union — never throws for HTTP-level failures.
4. Surfaces errors to the user via `toast.js` unless `{ silent: true }`
   is passed.

Types are documented in JSDoc `@typedef` comments mirroring the
server-side `_shapes.ts` names. When a shape changes, both files move
together.

## Wiring

`index.html` loads `<script type="module" src="/js/app.js">` from `<head>`.
ES modules are deferred, so:

- Inline scripts that reference `window.Sam` MUST do so from within event
  handlers, `DOMContentLoaded` listeners, or post-initial-render code —
  not at top-level during initial parse.
- The legacy inline `showToast` / `esc` / `attrJsArg` functions keep
  working for inline callsites. They are not removed until every inline
  reference is gone.
- `app.js` freezes `window.Sam` so nothing can accidentally mutate the
  namespace.

## Migration strategy

The migration order is chosen to maximize per-page risk isolation and to
build confidence in the renderer before it touches user-critical code.

1. **Scaffolding (this commit).** Add primitives + wiring + test page.
   Nothing old is removed.
2. **Verify renderer.** Open `/js/render.test.html`; all 10 tests must
   pass in your actual browser. This is the gate before any page adopts
   `renderList`.
3. **Low-risk page first: Tasks.** Tasks has a simple list render with
   clear row identity. Migrating it first proves the renderer on real
   data + real handlers + real mutations. After migration, the inline
   `renderTasks()` is deleted.
4. **Calendar.** Second-easiest; events have stable ids and the current
   render is already decoupled enough.
5. **Projects.** CRUD page with modal; similar shape to Tasks.
6. **Events timeline.** Aggregated from multiple sources; good test of
   keyed merge.
7. **Zoom list.** Straightforward row list.
8. **AI Workbench.** Chat list already DOM-capped; migrating it ensures
   the renderer handles append-only correctly.
9. **Email list.** Highest-risk page; migrated last. Phase-0 skip-render
   guard becomes redundant because the diff-renderer makes
   identity-equivalent re-renders free.
10. **Integrations page + remaining static panels.** Mostly static; last.
11. **Drop the dead code.** Inline functions replaced by modules are
    deleted; `index.html` trimmed toward its sub-800-line goal.

Each step above is its own commit with its own regression check: after
the commit, exercise every UI path on every page and verify Phase 0 exit
criteria remain green.

## 101% exit criteria for Phase 1

From the master plan:

- `index.html` is under 800 lines (shell only).
- Zero `innerHTML = ` writes for list UIs in the codebase. Spot-checked
  via grep. Toast and modal markup may keep small `innerHTML` usage;
  list rendering must go through `renderList`.
- Every `fetch()` call goes through `api.js`. Zero raw
  `fetch('/api/...')` outside that module.
- JSDoc types in `api.js` align with `_shapes.ts` by name. A type-drift
  lint passes (the simplest form: a script that greps for exported
  names in both files and reports mismatches).
- Manually exercising all 9 pages shows every interaction still works.
- Regression check: all Phase 0 exit criteria re-verified after the last
  page migrates.

## What Phase 1 does NOT include

- No TypeScript adoption on the client (stays JS + JSDoc).
- No framework (React, Svelte, Solid) adoption.
- No bundler (Vite, esbuild) on the client. The server already uses
  esbuild for function bundling via Netlify — that stays unchanged.
- No changes to function HTTP routes. `_shapes.ts` only types the
  request/response bodies, not the URL structure.
