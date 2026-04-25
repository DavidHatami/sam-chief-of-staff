// render.js — Keyed diff-renderer for SAM.
//
// Replaces the "list.innerHTML = html" anti-pattern that causes flicker,
// scroll loss, and hover/selection reset across the codebase. Items are
// matched by a stable key; the renderer adds, removes, moves, and updates
// DOM nodes in place instead of wiping the container.
//
// Usage:
//
//   import { renderList } from '/js/render.js';
//
//   renderList(parent, items, {
//     key:    (item) => item.id,
//     create: (item) => {
//       const el = document.createElement('div');
//       el.className = 'ei';
//       el.innerHTML = '…';  // innerHTML at the row level is fine —
//                            //  contained, not destroying siblings
//       return el;
//     },
//     update: (el, item) => {
//       // In-place patch. Only touch attributes/content that changed.
//       el.classList.toggle('unread', !item.isRead);
//     },
//   });
//
// Contract (from docs/PHASE-0-CONTRACTS.md):
//   - Scroll position of `parent` is preserved across renders.
//   - Focus + selection state of nodes that survive the render is preserved.
//   - Nodes that disappear from `items` are removed from the DOM.
//   - Nodes that stay are NOT re-created; only `update()` runs on them.
//   - Nodes that reorder use insertBefore, not remove+recreate.

/**
 * Reconcile `parent`'s children against `items`.
 * @param {Element} parent
 * @param {Array} items
 * @param {{key:(i:any)=>any, create:(i:any)=>Element, update?:(el:Element,i:any)=>void}} opts
 * @returns {{added:number, removed:number, updated:number, moved:number}}
 */
export function renderList(parent, items, opts) {
  if (!parent) throw new Error('renderList: parent is required');
  if (!Array.isArray(items)) throw new Error('renderList: items must be an array');
  const { key, create, update } = opts || {};
  if (typeof key !== 'function') throw new Error('renderList: opts.key must be a function');
  if (typeof create !== 'function') throw new Error('renderList: opts.create must be a function');

  const stats = { added: 0, removed: 0, updated: 0, moved: 0 };

  // Snapshot existing keyed children.
  const existing = new Map();
  for (const child of Array.from(parent.children)) {
    const k = child.getAttribute('data-key');
    if (k !== null) existing.set(k, child);
  }

  // Walk desired order.
  const seen = new Set();
  let prev = null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const k = String(key(item));
    let el = existing.get(k);
    if (el) {
      if (update) {
        try { update(el, item, i); stats.updated++; }
        catch (e) { console.error('[render] update failed for key', k, e); }
      }
    } else {
      try {
        el = create(item, i);
        if (!(el instanceof Element)) throw new Error('create() must return an Element');
        el.setAttribute('data-key', k);
        stats.added++;
      } catch (e) {
        console.error('[render] create failed for key', k, e);
        continue;
      }
    }
    seen.add(k);
    // Insert at correct position without disturbing other nodes.
    const target = prev === null ? parent.firstChild : prev.nextSibling;
    if (target !== el) {
      parent.insertBefore(el, target);
      if (existing.has(k)) stats.moved++;
    }
    prev = el;
  }

  // Remove leftovers.
  for (const [k, el] of existing) {
    if (!seen.has(k)) {
      el.remove();
      stats.removed++;
    }
  }

  return stats;
}

/**
 * Apply a single-value patch to an element's text content, skipping if equal.
 * Prevents cursor + selection reset in contenteditable / text nodes.
 * @param {Node} node
 * @param {string} text
 */
export function setText(node, text) {
  const s = String(text == null ? '' : text);
  if (node.textContent !== s) node.textContent = s;
}

/**
 * Apply a single-value patch to an attribute, skipping if equal.
 * @param {Element} el
 * @param {string} attr
 * @param {string|null} value  (null → removeAttribute)
 */
export function setAttr(el, attr, value) {
  if (value == null) {
    if (el.hasAttribute(attr)) el.removeAttribute(attr);
    return;
  }
  const s = String(value);
  if (el.getAttribute(attr) !== s) el.setAttribute(attr, s);
}

/**
 * Toggle a class based on a boolean. Cheaper than classList.toggle in hot
 * loops because it short-circuits when state matches.
 */
export function setClass(el, name, on) {
  const has = el.classList.contains(name);
  if (on && !has) el.classList.add(name);
  else if (!on && has) el.classList.remove(name);
}
