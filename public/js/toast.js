// toast.js — User-facing toast notifier.
//
// Replaces the inline showToast() definition that was attached to window at
// page scope in index.html. Same behavior, same styling, same 5s auto-hide.
//
// showToast(message, type?)
//   type: 'ok' (green) | 'err' (red) | 'info' (accent, default)
//
// The implementation lazily creates a single fixed-position container the
// first time it's called. Multiple rapid toasts stack vertically with a
// small gap and fade out independently.

const COLORS = {
  ok:   { bg: 'var(--green-dim)', fg: 'var(--green)', border: 'var(--green)' },
  err:  { bg: 'var(--red-dim)',   fg: 'var(--red)',   border: 'var(--red)' },
  info: { bg: 'var(--surface-2)', fg: 'var(--text)',  border: 'var(--accent)' },
};

let container = null;
function ensureContainer() {
  if (container && document.body.contains(container)) return container;
  container = document.createElement('div');
  container.id = 'sam-toast-container';
  container.style.cssText = [
    'position:fixed', 'bottom:20px', 'right:20px', 'z-index:99999',
    'display:flex', 'flex-direction:column', 'gap:8px',
    'pointer-events:none', 'max-width:360px',
  ].join(';');
  document.body.appendChild(container);
  return container;
}

/**
 * Show a toast notification.
 * @param {string} message
 * @param {'ok'|'err'|'info'} [type='info']
 * @param {{durationMs?:number}} [opts]
 */
export function showToast(message, type = 'info', opts = {}) {
  const c = ensureContainer();
  const colors = COLORS[type] || COLORS.info;
  const el = document.createElement('div');
  el.setAttribute('role', type === 'err' ? 'alert' : 'status');
  el.style.cssText = [
    'padding:10px 14px',
    'border-radius:8px',
    `background:${colors.bg}`,
    `color:${colors.fg}`,
    `border:1px solid ${colors.border}`,
    'font-family:var(--font)',
    'font-size:12px',
    'line-height:1.4',
    'box-shadow:0 8px 24px rgba(0,0,0,0.4)',
    'pointer-events:auto',
    'cursor:pointer',
    'opacity:0',
    'transform:translateY(10px)',
    'transition:opacity 180ms ease, transform 180ms ease',
  ].join(';');
  el.textContent = String(message == null ? '' : message);
  // Dismiss on click.
  el.addEventListener('click', () => dismiss(el));
  c.appendChild(el);
  // Animate in on the next frame.
  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';
  });
  const duration = Number.isFinite(opts.durationMs) ? opts.durationMs : 5000;
  setTimeout(() => dismiss(el), duration);
}

function dismiss(el) {
  if (!el.isConnected) return;
  el.style.opacity = '0';
  el.style.transform = 'translateY(10px)';
  setTimeout(() => el.remove(), 220);
}
