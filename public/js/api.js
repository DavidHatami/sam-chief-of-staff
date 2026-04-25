// api.js — Typed client for SAM's serverless API.
//
// One named async method per endpoint. Every method:
//   1. Uses a real route (single source of truth — no more 71 raw fetch() calls).
//   2. Checks r.ok before treating the response as success.
//   3. Normalizes error shape to { ok, status, error, data }.
//   4. Surfaces errors to the user via toast.js automatically unless
//      { silent: true } is passed.
//
// The client is INTENTIONALLY thin — it is a contract enforcer, not an
// abstraction layer. Server-side shapes live in netlify/functions/_shapes.ts;
// JSDoc `@typedef` imports mirror them here so editors catch drift.
//
// Phase-1 migration strategy:
//   - Code that still uses raw fetch('/api/...') works unchanged.
//   - New code imports from '/js/api.js' or uses window.Sam.api.*.
//   - Each page module migrates its fetch callsites to api.* as it lands.

import { showToast } from '/js/toast.js';

/** @typedef {{ ok: true, status: number, data: any, error?: never }} ApiOk */
/** @typedef {{ ok: false, status: number, error: string, data?: any }} ApiErr */
/** @typedef {ApiOk | ApiErr} ApiResult */

/**
 * Core fetch wrapper. Returns `{ ok, status, data, error? }` — never throws for
 * normal HTTP-level failures. Network errors become `ok:false` with a
 * synthetic 0 status.
 *
 * @param {string} url
 * @param {RequestInit & { silent?: boolean, timeoutMs?: number }} [init]
 * @returns {Promise<ApiResult>}
 */
async function request(url, init = {}) {
  const { silent = false, timeoutMs, ...rest } = init;
  const controller = typeof timeoutMs === 'number' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const r = await fetch(url, { ...rest, signal: controller?.signal });
    const contentType = r.headers.get('content-type') || '';
    const body = contentType.includes('application/json')
      ? await r.json().catch(() => ({}))
      : await r.text().catch(() => '');
    if (!r.ok) {
      const err = (body && body.error) || `HTTP ${r.status}`;
      if (!silent) showToast(prettyError(url, err), 'err');
      return { ok: false, status: r.status, error: err, data: body };
    }
    return { ok: true, status: r.status, data: body };
  } catch (e) {
    const err = e && e.name === 'AbortError'
      ? `Request timed out after ${timeoutMs}ms`
      : (e && e.message) || String(e);
    if (!silent) showToast(prettyError(url, err), 'err');
    return { ok: false, status: 0, error: err };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function prettyError(url, msg) {
  const short = String(msg || '').slice(0, 200);
  const path = String(url).replace(/^https?:\/\/[^/]+/, '');
  return `${path}: ${short}`;
}

// ──────────────────────────────────────────────────────────────────────────
// ENDPOINT METHODS
// ──────────────────────────────────────────────────────────────────────────

export const api = {
  // ── AI ─────────────────────────────────────────────────────────────────
  ai: {
    /**
     * @param {{model:'claude'|'openai'|'gemini'|'council'|'grok', prompt:string, history?:Array}} body
     * @param {{silent?:boolean, timeoutMs?:number}} [opts]
     */
    ask(body, opts) {
      return request('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: (opts && opts.timeoutMs) ?? 25000,
        silent: opts && opts.silent,
      });
    },
  },

  // ── EMAIL (multi-provider) ─────────────────────────────────────────────
  email: {
    /** @param {{provider:'m365'|'gmail'|'yahoo', folder?:string, top?:number, prefetch?:boolean}} q */
    list(q, opts) {
      const base = providerBase(q.provider);
      const params = new URLSearchParams();
      params.set('folder', q.folder || 'inbox');
      if (q.top) params.set('top', String(q.top));
      if (q.prefetch) params.set('prefetch', '1');
      return request(`${base}/mail?${params}`, { silent: opts && opts.silent });
    },
    /** @param {{provider:'m365'|'gmail'|'yahoo', id:string, prefetch?:boolean}} q */
    read(q, opts) {
      const base = providerBase(q.provider);
      const params = new URLSearchParams();
      params.set('id', q.id);
      if (q.prefetch) params.set('prefetch', '1');
      return request(`${base}/mail?${params}`, { silent: opts && opts.silent });
    },
    /** @param {{provider:string, to:string|string[], subject:string, content:string, contentType?:'HTML'|'text', cc?, bcc?}} body */
    send(body, opts) {
      const acct = providerSendBase(body.provider);
      return request(acct, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        silent: opts && opts.silent,
      });
    },
    /** @param {{provider:string, id:string, folder?:string}} q */
    delete(q, opts) {
      const base = providerBase(q.provider);
      const params = new URLSearchParams();
      params.set('id', q.id);
      if (q.folder) params.set('folder', q.folder);
      return request(`${base}/mail?${params}`, {
        method: 'DELETE',
        silent: opts && opts.silent,
      });
    },
  },

  // ── CALENDAR ───────────────────────────────────────────────────────────
  calendar: {
    list(q, opts) {
      const source = q && q.source === 'google' ? '/api/gcal/events' : '/api/m365/calendar';
      const params = new URLSearchParams();
      if (q && q.start) params.set('start', q.start);
      if (q && q.end) params.set('end', q.end);
      const qs = params.toString();
      return request(qs ? `${source}?${qs}` : source, { silent: opts && opts.silent });
    },
  },

  // ── TASKS ──────────────────────────────────────────────────────────────
  tasks: {
    list(opts) { return request('/api/tasks/', { silent: opts && opts.silent }); },
    create(task, opts) {
      return request('/api/tasks/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(task),
        silent: opts && opts.silent,
      });
    },
    update(id, patch, opts) {
      return request(`/api/tasks/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
        silent: opts && opts.silent,
      });
    },
    delete(id, opts) {
      return request(`/api/tasks/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        silent: opts && opts.silent,
      });
    },
  },

  // ── PROJECTS ───────────────────────────────────────────────────────────
  projects: {
    list(opts) { return request('/api/projects', { silent: opts && opts.silent }); },
    get(id, opts) { return request(`/api/projects/${encodeURIComponent(id)}`, { silent: opts && opts.silent }); },
    create(p, opts) {
      return request('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p),
        silent: opts && opts.silent,
      });
    },
    update(id, patch, opts) {
      return request(`/api/projects/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
        silent: opts && opts.silent,
      });
    },
    delete(id, opts) {
      return request(`/api/projects/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        silent: opts && opts.silent,
      });
    },
    context(id, opts) { return request(`/api/projects/${encodeURIComponent(id)}/context`, { silent: opts && opts.silent }); },
    addKnowledge(id, kb, opts) {
      return request(`/api/projects/${encodeURIComponent(id)}/kb`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(kb),
        silent: opts && opts.silent,
      });
    },
    deleteKnowledge(id, kbId, opts) {
      return request(`/api/projects/${encodeURIComponent(id)}/kb/${encodeURIComponent(kbId)}`, {
        method: 'DELETE',
        silent: opts && opts.silent,
      });
    },
  },

  // ── INSTRUCTIONS (PERMANENT MEMORY) ────────────────────────────────────
  instructions: {
    list(opts) { return request('/api/instructions', { silent: opts && opts.silent }); },
    create(i, opts) {
      return request('/api/instructions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(i),
        silent: opts && opts.silent,
      });
    },
    update(id, patch, opts) {
      return request(`/api/instructions/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
        silent: opts && opts.silent,
      });
    },
    delete(id, opts) {
      return request(`/api/instructions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        silent: opts && opts.silent,
      });
    },
    compress(id, opts) {
      return request(`/api/instructions/${encodeURIComponent(id)}/compress`, {
        method: 'POST',
        timeoutMs: 20000,
        silent: opts && opts.silent,
      });
    },
    compressAll(opts) {
      return request('/api/instructions/compress-all', {
        method: 'POST',
        timeoutMs: 25000,
        silent: opts && opts.silent,
      });
    },
  },

  // ── ZOOM ───────────────────────────────────────────────────────────────
  zoom: {
    meetings(opts) { return request('/api/zoom/meetings', { silent: opts && opts.silent }); },
    recordings(opts) { return request('/api/zoom/recordings', { silent: opts && opts.silent }); },
    transcript(id, opts) { return request(`/api/zoom/transcript?id=${encodeURIComponent(id)}`, { silent: opts && opts.silent }); },
    createMeeting(body, opts) {
      return request('/api/zoom/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        silent: opts && opts.silent,
      });
    },
    deleteMeeting(id, opts) {
      return request(`/api/zoom/meetings?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
        silent: opts && opts.silent,
      });
    },
    deleteRecording(id, opts) {
      return request(`/api/zoom/recordings?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
        silent: opts && opts.silent,
      });
    },
  },

  // ── FLAGS ──────────────────────────────────────────────────────────────
  flags: {
    list(opts) { return request('/api/flags', { silent: opts && opts.silent }); },
    add(q, opts) {
      return request('/api/flags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(q),
        silent: opts && opts.silent,
      });
    },
    remove(q, opts) {
      const params = new URLSearchParams();
      if (q.id) params.set('id', q.id);
      if (q.acct) params.set('acct', q.acct);
      return request(`/api/flags?${params}`, {
        method: 'DELETE',
        silent: opts && opts.silent,
      });
    },
  },

  // ── BACKUP ─────────────────────────────────────────────────────────────
  backup: {
    status(opts) { return request('/api/backup', { silent: opts && opts.silent }); },
    run(opts) {
      return request('/api/backup', {
        method: 'POST',
        timeoutMs: 25000,
        silent: opts && opts.silent,
      });
    },
  },

  // ── BOOKING ────────────────────────────────────────────────────────────
  book: {
    create(body, opts) {
      return request('/api/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        silent: opts && opts.silent,
      });
    },
  },

  // ── BRIEFING (Phase 1.1 Morning Briefing Engine) ───────────────────────
  briefing: {
    /**
     * Fire a briefing right now (same code path as the 6 AM cron).
     * Returns BriefingRunResponse on success. Long-running — budget ~25s for
     * data-fetch + Claude synthesis + Resend email + blob archive.
     */
    run(opts) {
      return request('/api/briefing/now', {
        method: 'POST',
        timeoutMs: (opts && opts.timeoutMs) ?? 25000,
        silent: opts && opts.silent,
      });
    },
    /** Up to 30 most recent archived briefing dates (BriefingHistoryResponse). */
    history(opts) {
      return request('/api/briefing/history', { silent: opts && opts.silent });
    },
    /** @param {string} date YYYY-MM-DD  → BriefingArchive */
    get(date, opts) {
      return request(`/api/briefing/get?date=${encodeURIComponent(date)}`, {
        silent: opts && opts.silent,
      });
    },
  },

  // ── LOW-LEVEL ESCAPE HATCH ─────────────────────────────────────────────
  // For edge cases not yet modeled above. Discouraged — add a real method
  // to this client instead when you reach for this.
  raw: request,
};

function providerBase(p) {
  switch (p) {
    case 'm365':  return '/api/m365';
    case 'gmail': return '/api/gmail';
    case 'yahoo': return '/api/yahoo';
    default: throw new Error(`api.email: unknown provider ${p}`);
  }
}
function providerSendBase(p) {
  switch (p) {
    case 'm365':    return '/api/m365/mail/send';
    case 'gmail':   return '/api/gmail/mail/send';
    case 'yahoo':   return '/api/yahoo/mail/send';
    case 'resend':  return '/api/resend-send';
    default: throw new Error(`api.email.send: unknown provider ${p}`);
  }
}
