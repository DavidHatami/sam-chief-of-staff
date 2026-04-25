// app.js — Phase-1 module entry point.
//
// Loaded as <script type="module" src="/js/app.js"> from index.html.
// Exposes the new primitive modules on a single `window.Sam` namespace so
// legacy inline code in index.html can opt in progressively without a build
// step. As pages migrate to real ES module imports, they can stop going
// through window.Sam.

import { createSignal, createStore } from '/js/state.js';
import { renderList, setText, setAttr, setClass } from '/js/render.js';
import { esc, attrJsArg } from '/js/esc.js';
import { showToast } from '/js/toast.js';
import { api } from '/js/api.js';

// Page modules. Each one self-registers its public handlers onto `window`
// so legacy inline onclick / page-router callsites keep working during
// migration. As pages migrate they are imported here; unmigrated pages
// continue to use their inline implementations until they are ported.
import '/js/pages/tasks.js';

const Sam = {
  version: '0.1.0-phase1-scaffold',
  state: { createSignal, createStore },
  render: { renderList, setText, setAttr, setClass },
  esc, attrJsArg,
  showToast,
  api,
};

// Expose. Do not clobber if something is already there — treat as merge so
// existing page-scope `window.showToast` (inline) keeps working alongside
// `window.Sam.showToast` (module) until the inline version is removed.
Object.defineProperty(window, 'Sam', {
  value: Object.freeze(Sam),
  writable: false,
  configurable: false,
  enumerable: true,
});

// Tiny boot indicator for console-based verification.
if (typeof console !== 'undefined' && console.log) {
  console.log('[SAM] phase-1 modules loaded:', Object.keys(Sam).join(', '));
}
