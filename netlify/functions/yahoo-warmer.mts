import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

/**
 * SAM — YAHOO FAST-PATH PRE-WARMER
 *
 * The problem: Yahoo IMAP has high fixed latency (~500–1500ms TLS handshake + auth +
 * mailbox lock + fetch), which hits EVERY user request when there's no warm cache.
 * The existing in-memory cache inside yahoo.mts dies on every Netlify cold start —
 * serverless functions scale to zero, so the next request always pays the full
 * IMAP connection cost.
 *
 * The fix: pre-warm out-of-band. This scheduled function runs every 2 minutes,
 * pulls the inbox + sent folder snapshots via IMAP, and writes them to a
 * Netlify Blob. The `yahoo-fast.mts` HTTP endpoint reads ONLY from blob — no
 * IMAP, no waiting. Result: ~50ms response vs 1500ms+ average.
 *
 * Trade: inbox snapshot is up to 2 minutes stale. For a Chief of Staff dashboard
 * that's a non-issue — SAM already classifies mail via the triage agent every
 * 20 minutes. Two minutes is strictly better than status quo.
 *
 * Triggered endpoint: GET /api/yahoo-fast/mail?folder=inbox|sent&top=25
 * Fallback: if blob is empty/stale beyond 10 min, client falls back to /api/yahoo/mail.
 */

const INBOX_TOP = 30;
const SENT_TOP = 20;

async function pullFolder(client: ImapFlow, mailbox: string, top: number) {
  const lock = await client.getMailboxLock(mailbox);
  try {
    const status = await client.status(mailbox, { messages: true });
    const total = status.messages || 0;
    if (total === 0) return [];
    const startSeq = Math.max(1, total - top + 1);
    const range = `${startSeq}:${total}`;
    const out: any[] = [];
    for await (const msg of client.fetch(range, {
      uid: true,
      flags: true,
      envelope: true,
      bodyStructure: false,
      source: false,
      headers: ["from", "to", "subject", "date"],
    })) {
      const env = msg.envelope || {};
      const from = (env.from && env.from[0]) || {};
      out.push({
        id: String(msg.uid),
        subject: env.subject || "(no subject)",
        from: {
          emailAddress: {
            name: from.name || from.address || "unknown",
            address: from.address || "",
          },
        },
        receivedDateTime: env.date ? new Date(env.date).toISOString() : new Date().toISOString(),
        isRead: msg.flags ? msg.flags.has("\\Seen") : false,
        bodyPreview: "",
      });
    }
    // newest first
    out.sort((a, b) => new Date(b.receivedDateTime).getTime() - new Date(a.receivedDateTime).getTime());
    return out;
  } finally {
    lock.release();
  }
}

export default async (req: Request, context: Context) => {
  const email = Netlify.env.get("YAHOO_EMAIL");
  const appPassword = Netlify.env.get("YAHOO_APP_PASSWORD");
  if (!email || !appPassword) {
    console.error("[YAHOO-WARMER] credentials missing");
    return;
  }

  const client = new ImapFlow({
    host: "imap.mail.yahoo.com",
    port: 993,
    secure: true,
    auth: { user: email, pass: appPassword },
    logger: false,
    greetingTimeout: 8000,
    socketTimeout: 15000,
    emitLogs: false,
  });

  const started = Date.now();
  try {
    await client.connect();
    const [inbox, sent] = await Promise.all([
      pullFolder(client, "INBOX", INBOX_TOP),
      pullFolder(client, "Sent", SENT_TOP),
    ]);

    // Write snapshot FIRST. A logout failure after this point cannot lose
    // successfully-fetched data — previously, a transient TLS hiccup during
    // logout would discard a perfectly good fetch.
    const store = getStore({ name: "sam-yahoo-cache", consistency: "strong" });
    const snapshot = {
      inbox,
      sent,
      refreshedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    };
    await store.setJSON("snapshot", snapshot);

    // Logout is best-effort. We already have the data; a failed logout just
    // means the IMAP socket gets reaped by the timeout. No user impact.
    try { await client.logout(); } catch {}

    console.log(
      `[YAHOO-WARMER] ok inbox=${inbox.length} sent=${sent.length} ${Date.now() - started}ms`
    );
  } catch (e: any) {
    try { await client.logout(); } catch {}
    console.error("[YAHOO-WARMER] failed:", e.message);
  }
};

export const config: Config = {
  // Every 2 minutes — keeps snapshot fresh without hammering Yahoo IMAP.
  schedule: "*/2 * * * *",
};
