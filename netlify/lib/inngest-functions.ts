/**
 * SAM INNGEST FUNCTIONS — registered with Inngest's runtime
 *
 * Each function declares which event types it subscribes to and runs as a
 * series of `step.run()` and `step.sleep()` calls. Each step is durably
 * persisted by Inngest, so a function can sleep for hours, retry on
 * failure, and survive deploys mid-run without losing state.
 *
 * This is the architectural difference from the polling reactor:
 *   - Reactor: single side effect, runs in <1s, no retry across restarts
 *   - Inngest function: multi-step, can sleep for days, retries forever
 *
 * Phase 7 ships with one demo function so the dashboard has something
 * to show after Sync. Real workflows (booking flow, transcript-to-task
 * with delays, multi-channel notifications) get added as separate files
 * importing from the same client.
 */

import { Inngest } from "inngest";
// @ts-ignore Netlify global
const eventKey = typeof Netlify !== "undefined" ? Netlify.env.get("INNGEST_EVENT_KEY") : process.env.INNGEST_EVENT_KEY;
// @ts-ignore Netlify global
const signingKey = typeof Netlify !== "undefined" ? Netlify.env.get("INNGEST_SIGNING_KEY") : process.env.INNGEST_SIGNING_KEY;

// Build a separate client instance for the serve handler. The eventKey
// is optional here (the serve handler doesn't send events), but signing
// key is required to verify webhooks from Inngest.
export const inngest = new Inngest({
  id: "sam-chief-of-staff",
  ...(eventKey ? { eventKey } : {}),
  ...(signingKey ? { signingKey } : {}),
});

// ─────────────────────────────────────────────────────────────────────────
// DEMO FUNCTION — proves the round-trip works end-to-end
// ─────────────────────────────────────────────────────────────────────────
//
// Triggered when ANY task is created. Logs receipt, sleeps 10 seconds
// (proving Inngest manages durable sleeps), then logs completion. Shows
// up in the Inngest dashboard's Runs view as a 2-step run.
//
// Replace or augment this with real workflows once a production use case
// is identified. Until then, this is the smallest meaningful demonstration
// that the integration is wired up correctly.
export const taskCreatedAcknowledger = inngest.createFunction(
  {
    id: "task-created-ack",
    name: "Acknowledge task creation",
  },
  { event: "sam/task.created" },
  async ({ event, step }) => {
    const taskId = event.data?.entity_id;
    const title = event.data?.title;

    await step.run("log-receipt", async () => {
      console.log(`[inngest] received task.created id=${taskId} title="${title}"`);
      return { acknowledged_at: new Date().toISOString() };
    });

    await step.sleep("brief-pause", "10s");

    return await step.run("log-completion", async () => {
      console.log(`[inngest] task.created flow complete for id=${taskId}`);
      return { completed_at: new Date().toISOString(), task_id: taskId };
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────
// Registry — anything serve() needs to be told about
// ─────────────────────────────────────────────────────────────────────────
export const functions = [
  taskCreatedAcknowledger,
];
