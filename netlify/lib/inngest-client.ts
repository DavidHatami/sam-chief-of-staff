/**
 * SAM ↔ INNGEST — Phase 7 (partial)
 *
 * The Inngest client is the single point through which SAM sends domain
 * events out to Inngest's workflow runtime. Inngest then invokes any
 * functions defined in inngest-functions.ts that subscribe to those event
 * types.
 *
 * Design:
 *   - Singleton client cached per warm container
 *   - Lazy init: returns null if INNGEST_EVENT_KEY is not set, so SAM
 *     keeps working even when Inngest is misconfigured
 *   - Event names are namespaced by entity type (e.g. "sam/task.created")
 *     so the Inngest dashboard groups them sensibly
 */

import { Inngest } from "inngest";

let _client: Inngest | null = null;
let _initAttempted = false;

export function getInngest(): Inngest | null {
  if (_client) return _client;
  if (_initAttempted && !_client) return null;
  _initAttempted = true;

  // @ts-ignore Netlify global
  const eventKey = typeof Netlify !== "undefined" ? Netlify.env.get("INNGEST_EVENT_KEY") : process.env.INNGEST_EVENT_KEY;
  if (!eventKey) {
    console.warn("[inngest] INNGEST_EVENT_KEY not set — Inngest forwarding disabled");
    return null;
  }

  try {
    _client = new Inngest({
      id: "sam-chief-of-staff",
      eventKey,
    });
    return _client;
  } catch (e: any) {
    console.error("[inngest] init failed:", e?.message || e);
    return null;
  }
}

/**
 * Send a SAM domain event to Inngest. Wraps the SDK with a try/catch so
 * SAM never goes down if Inngest is unreachable. Naming convention:
 * "sam/<original.event.type>" so functions match on the original type
 * after the namespace.
 */
export async function sendToInngest(input: {
  type: string;          // original SAM event type, e.g. "task.created"
  entityType?: string | null;
  entityId?: string | null;
  payload: Record<string, any>;
  correlationId?: string | null;
}): Promise<boolean> {
  const client = getInngest();
  if (!client) return false;
  try {
    await client.send({
      name: `sam/${input.type}`,
      data: {
        entity_type: input.entityType ?? null,
        entity_id: input.entityId ?? null,
        correlation_id: input.correlationId ?? null,
        ...input.payload,
      },
    });
    return true;
  } catch (e: any) {
    console.error("[inngest] send failed:", e?.message || e);
    return false;
  }
}
