// esc.js — HTML and JS-attribute escape helpers.
//
// Two helpers extracted from index.html. Kept as ES module exports so Phase-1
// code can import them; app.js also exposes them as window.Sam.esc /
// window.Sam.attrJsArg for legacy inline-onclick callsites.
//
// esc(s)
//   HTML-escapes a string for safe insertion into element text / innerHTML.
//   Uses DOM textContent → innerHTML round-trip so every entity is handled
//   (matches browser semantics exactly).
//
// attrJsArg(s)
//   Produces a safe argument string for inline onclick="foo('...')" handlers.
//   Standard HTML escape is insufficient there because the browser decodes
//   entities back before the JS parser sees them, so an apostrophe in a
//   Zoom meeting title or AI-generated action item breaks the handler.
//   This serializes via JSON.stringify (handles quotes, backslashes,
//   unicode controls) then HTML-escapes the quote character so the outer
//   attribute delimiter stays balanced.
//   (Phase 1+ migrates away from inline onclick; helper stays available
//    for legacy markup during the transition.)

export function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

export function attrJsArg(s) {
  const json = JSON.stringify(s == null ? '' : String(s));
  // json is "\"…\"". Replace the surrounding double-quotes + any internal
  // occurrences with HTML entity so the attribute string stays valid.
  return json.replace(/"/g, '&quot;');
}
