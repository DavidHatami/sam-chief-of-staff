/**
 * SENTRY WRAPPER — error tracking for SAM
 *
 * Single init point. No-op when SENTRY_DSN env var is missing, so dev
 * environments never need Sentry credentials.
 *
 * Activation steps for David (one-time):
 *   1. Sign up at https://sentry.io (free tier covers SAM by an order of magnitude)
 *   2. Create a project, choose "Node.js" platform
 *   3. Copy the DSN (looks like https://abc123@o12345.ingest.sentry.io/123456)
 *   4. In Netlify: Site Settings → Environment Variables → SENTRY_DSN = <paste>
 *   5. Trigger a redeploy. Sentry starts catching exceptions automatically.
 *
 * Once active, every captureException() call in SAM lands in the Sentry
 * issues tab with stack trace, function name, and any context attached.
 */

let _initialized = false;
let _Sentry: any = null;

async function ensureInit(): Promise<any | null> {
  if (_initialized) return _Sentry;
  _initialized = true;

  // @ts-ignore — Netlify global
  const dsn = typeof Netlify !== "undefined" ? Netlify.env.get("SENTRY_DSN") : process.env.SENTRY_DSN;
  if (!dsn) return null;

  try {
    // Dynamic import so functions without Sentry installed don't crash.
    const mod = await import("@sentry/node");
    mod.init({
      dsn,
      // @ts-ignore
      environment: typeof Netlify !== "undefined" ? (Netlify.env.get("CONTEXT") || "production") : "production",
      tracesSampleRate: 0.0, // tracing off — we just want errors
      sendDefaultPii: false,
    });
    _Sentry = mod;
    return _Sentry;
  } catch (e) {
    // Sentry not installed or broken — silent fall-through, never block SAM.
    return null;
  }
}

/**
 * Capture an exception. Safe to call from any function. Never throws.
 * Context is a small key/value object — function name, user id, request id.
 */
export async function captureException(err: any, context?: Record<string, any>): Promise<void> {
  try {
    const s = await ensureInit();
    if (!s) return;
    if (context && Object.keys(context).length > 0) {
      s.withScope((scope: any) => {
        for (const [k, v] of Object.entries(context)) {
          try { scope.setExtra(k, v); } catch {}
        }
        s.captureException(err);
      });
    } else {
      s.captureException(err);
    }
  } catch {
    // Sentry capture must never crash the caller.
  }
}

/**
 * Capture a message (warn or info severity). Use sparingly — issues you
 * actually want to look at, not log noise.
 */
export async function captureMessage(msg: string, level: "info" | "warning" | "error" = "warning", context?: Record<string, any>): Promise<void> {
  try {
    const s = await ensureInit();
    if (!s) return;
    if (context && Object.keys(context).length > 0) {
      s.withScope((scope: any) => {
        for (const [k, v] of Object.entries(context)) {
          try { scope.setExtra(k, v); } catch {}
        }
        s.captureMessage(msg, level);
      });
    } else {
      s.captureMessage(msg, level);
    }
  } catch {
    // Sentry capture must never crash the caller.
  }
}

/**
 * Wrap a Netlify Function handler so any uncaught throw lands in Sentry
 * with the function name attached, then re-throws so Netlify still gets
 * the 500 response.
 */
export function wrapHandler<T extends (...args: any[]) => any>(name: string, fn: T): T {
  return (async (...args: any[]) => {
    try {
      return await fn(...args);
    } catch (err: any) {
      await captureException(err, { function: name });
      throw err;
    }
  }) as any as T;
}
