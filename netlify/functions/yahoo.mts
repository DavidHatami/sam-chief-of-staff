import type { Context, Config } from "@netlify/functions";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

/**
 * Yahoo Mail Integration for SAM via IMAP
 *
 * GET  /api/yahoo/mail            → List inbox or sent
 * GET  /api/yahoo/mail?id=X       → Read single message
 * POST /api/yahoo/mail/send       → Send email via SMTP
 * DELETE /api/yahoo/mail?id=X     → Delete/trash email
 *
 * REQUIRED ENV VARS:
 *   YAHOO_EMAIL       (dh30111@yahoo.com)
 *   YAHOO_APP_PASSWORD (Yahoo App Password — NOT your login password)
 */

// Two-tier cache strategy.
//   L1 (in-memory Maps below): instant within the same warm Lambda container.
//                                Dies on cold start. Per-container, not shared.
//   L2 (Netlify Blob 'sam-yahoo-cache'): survives cold starts; shared across instances.
//                                Adds ~30-50ms per get vs L1, but saves 5-8s vs IMAP.
//
// Read path: L1 (<1ms hit) → L2 blob (~30ms hit) → live IMAP (~5-8s miss).
// Write path: write through to both L1 and L2.
type CacheEntry = { timestamp: number; data: any };
const LIST_TTL_MS = 30000;        // L1 in-memory TTL — 30s for list views
const BODY_TTL_MS = 300000;       // L1 in-memory TTL — 5min for bodies (immutable)
const L2_LIST_TTL_MS = 180000;    // L2 blob TTL — 3min lists, longer than L1 so cold starts rescue
const L2_BODY_TTL_MS = 1800000;   // L2 blob TTL — 30min bodies (still fresh-enough, message bodies don't change)
const listCache: Map<string, CacheEntry> = new Map();
const bodyCache: Map<string, CacheEntry> = new Map();

// L2 blob cache helpers — write-through, async, never block the user request.
// Keys are namespaced "list:" and "body:" to share one blob store.
async function l2Get(key: string, ttl: number): Promise<any | null> {
  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore({ name: "sam-yahoo-cache", consistency: "strong" });
    const raw = await store.get(key, { type: "json" }) as CacheEntry | null;
    if (!raw) return null;
    if (Date.now() - raw.timestamp > ttl) return null;
    return raw.data;
  } catch {
    return null; // blob errors must not break the user path
  }
}
async function l2Set(key: string, data: any): Promise<void> {
  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore({ name: "sam-yahoo-cache", consistency: "strong" });
    await store.setJSON(key, { timestamp: Date.now(), data });
  } catch {
    // best-effort — don't block on cache writes
  }
}

function getCached(cache: Map<string, CacheEntry>, key: string, ttl: number): any | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > ttl) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}
function setCached(cache: Map<string, CacheEntry>, key: string, data: any): void {
  cache.set(key, { timestamp: Date.now(), data });
  // Prevent unbounded growth — cap at 100 entries per cache
  if (cache.size > 100) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
    if (oldest) cache.delete(oldest[0]);
  }
}
function invalidateListCache(): void {
  listCache.clear();
  // L2 list entries naturally expire on TTL — explicit invalidation skipped
  // since blob list+delete would add latency to mutations.
}

function folderMap_static(folder: string): string {
  const m: Record<string, string> = {
    "inbox": "INBOX", "sent": "Sent", "sentitems": "Sent",
    "drafts": "Draft", "trash": "Trash",
  };
  return m[folder] || "INBOX";
}

async function getImapClient(): Promise<ImapFlow> {
  const email = Netlify.env.get("YAHOO_EMAIL");
  const appPassword = Netlify.env.get("YAHOO_APP_PASSWORD");

  if (!email || !appPassword) {
    throw new Error(
      "Yahoo credentials not configured. Set YAHOO_EMAIL and YAHOO_APP_PASSWORD in Netlify env vars."
    );
  }

  const client = new ImapFlow({
    host: "imap.mail.yahoo.com",
    port: 993,
    secure: true,
    auth: { user: email, pass: appPassword },
    logger: false,
    greetingTimeout: 5000,
    socketTimeout: 8000,
    emitLogs: false,
  });

  await client.connect();
  return client;
}

interface EmailMsg {
  id: string;
  subject: string;
  from: { emailAddress: { name: string; address: string } };
  receivedDateTime: string;
  isRead: boolean;
  bodyPreview: string;
  body?: { contentType: string; content: string };
  toRecipients?: { emailAddress: { address: string } }[];
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const path = url.pathname.replace("/api/yahoo", "");
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "private, max-age=30, stale-while-revalidate=60",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  };

  if (req.method === "OPTIONS") {
    return new Response("", { status: 204, headers });
  }

  let client: ImapFlow | null = null;

  try {
    // ── LIST MESSAGES ──
    if (path === "/mail" && req.method === "GET") {
      const msgId = url.searchParams.get("id");
      const folder = url.searchParams.get("folder") || "inbox";
      const top = parseInt(url.searchParams.get("top") || "15");
      const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0"));
      const isPrefetch = url.searchParams.get("prefetch") === "1";

      // CACHE CHECK — short-circuit before opening IMAP connection (saves 500-1000ms TLS handshake + auth)
      if (msgId) {
        const cacheKey = `body:${msgId}`;
        let cached = getCached(bodyCache, cacheKey, BODY_TTL_MS);
        let cacheTier: "hit" | "l2-hit" = "hit"; // "hit" = L1, "l2-hit" = L2 (cold-start-survivor)
        // L1 miss → try L2 persistent blob (survives cold start)
        if (!cached) {
          const l2 = await l2Get(cacheKey, L2_BODY_TTL_MS);
          if (l2) {
            cached = l2;
            cacheTier = "l2-hit";
            setCached(bodyCache, cacheKey, cached); // promote into L1
          }
        }
        if (cached) {
          // If not a prefetch and still unread, mark-as-read on the server BEFORE returning.
          // Previously this was fire-and-forget via IIFE, but serverless kills the Lambda
          // after response is sent, so the async work could silently never complete —
          // cached body showed isRead=true while server still had it unread, causing state oscillation.
          // Awaiting is ~300-500ms slower than pure cache hit but still faster than no-cache (~1s+), and correct.
          if (!isPrefetch && !cached.isRead) {
            try {
              const c = await getImapClient();
              const l = await c.getMailboxLock(folderMap_static(folder));
              try { await c.messageFlagsAdd(String(msgId), ["\\Seen"], { uid: true }); } catch (e) {}
              l.release();
              await c.logout();
              cached.isRead = true;
              invalidateListCache(); // list counts changed
            } catch (e) {
              // If mark-read fails, leave cached.isRead alone so UI state matches server
            }
          }
          return new Response(JSON.stringify(cached), { headers: { ...headers, "X-Cache": cacheTier } });
        }
      } else {
        const cacheKey = `list:${folder}:${top}:${offset}`;
        let cached = getCached(listCache, cacheKey, LIST_TTL_MS);
        // L1 miss → try L2 persistent blob
        if (!cached) {
          const l2 = await l2Get(cacheKey, L2_LIST_TTL_MS);
          if (l2) {
            cached = l2;
            setCached(listCache, cacheKey, cached); // promote into L1
            return new Response(JSON.stringify(cached), { headers: { ...headers, "X-Cache": "l2-hit" } });
          }
        }
        if (cached) {
          return new Response(JSON.stringify(cached), { headers: { ...headers, "X-Cache": "hit" } });
        }
      }

      client = await getImapClient();

      // Map folder param to Yahoo mailbox names
      const folderMap: Record<string, string> = {
        "inbox": "INBOX",
        "sent": "Sent",
        "sentitems": "Sent",
        "drafts": "Draft",
        "trash": "Trash",
      };
      const mailbox = folderMap[folder] || "INBOX";
      const lock = await client.getMailboxLock(mailbox);

      try {
        // Single message — full body
        if (msgId) {
          const uid = parseInt(msgId);
          // Fetch flags first to determine real isRead state
          let wasRead = false;
          try {
            for await (const m of client.fetch(String(uid), { uid: true, flags: true })) {
              wasRead = m.flags.has("\\Seen");
              break;
            }
          } catch (e) {}

          const source = await client.download(String(uid), undefined, {
            uid: true,
          });
          const parsed = await simpleParser(source.content);

          const fromAddr =
            parsed.from?.value?.[0]?.address || "";
          const fromName =
            parsed.from?.value?.[0]?.name || fromAddr;

          const toRecipients = (parsed.to
            ? Array.isArray(parsed.to)
              ? parsed.to
              : [parsed.to]
            : []
          ).flatMap((t: any) =>
            t.value
              ? t.value.map((v: any) => ({
                  emailAddress: { address: v.address || "" },
                }))
              : []
          );

          const result: EmailMsg = {
            id: String(uid),
            subject: parsed.subject || "(no subject)",
            from: {
              emailAddress: { name: fromName, address: fromAddr },
            },
            receivedDateTime: parsed.date?.toISOString() || "",
            isRead: wasRead,
            bodyPreview: parsed.text?.substring(0, 300) || "",
            body: {
              contentType: parsed.html ? "html" : "Text",
              content: (parsed.html as string) || parsed.text || "",
            },
            toRecipients,
          };

          // Mark as seen ONLY on real read (not prefetch)
          if (!isPrefetch) {
            try {
              await client.messageFlagsAdd(String(uid), ["\\Seen"], {
                uid: true,
              });
              result.isRead = true;
            } catch (e) {}
          }

          lock.release();
          await client.logout();
          // Write body to cache (L1 sync, L2 awaited so blob lands before Lambda exits)
          setCached(bodyCache, `body:${String(uid)}`, result);
          try { await l2Set(`body:${String(uid)}`, result); } catch {}
          // If we marked as read, invalidate list cache (isRead count changed)
          if (!isPrefetch) invalidateListCache();
          return new Response(JSON.stringify(result), { headers: { ...headers, "X-Cache": "miss" } });
        }

        // List messages
        const messages: EmailMsg[] = [];
        let count = 0;

        // Get message sequence range — latest N messages, skipping `offset` newer ones
        const status = await client.status(mailbox, { messages: true });
        const total = status.messages || 0;
        if (total === 0 || offset >= total) {
          lock.release();
          await client.logout();
          return new Response(JSON.stringify({ value: [], total, offset, hasMore: false }), { headers });
        }
        // For pagination: pull (total - offset - top + 1) through (total - offset)
        const endSeq = total - offset;
        const startSeq = Math.max(1, endSeq - top + 1);
        const range = `${startSeq}:${endSeq}`;

        // Fetch in reverse order (newest first) — envelope+flags only, no body
        for await (const msg of client.fetch(range, {
          uid: true,
          envelope: true,
          flags: true,
        })) {
          const env = msg.envelope;
          const fromAddr = env.from?.[0]?.address || "";
          const fromName = env.from?.[0]?.name || fromAddr;
          const isRead = msg.flags.has("\\Seen");

          messages.push({
            id: String(msg.uid),
            subject: env.subject || "(no subject)",
            from: {
              emailAddress: { name: fromName, address: fromAddr },
            },
            receivedDateTime: env.date?.toISOString() || "",
            isRead,
            bodyPreview: "",
          });
          count++;
          if (count >= top) break;
        }

        // Reverse so newest is first
        messages.reverse();

        lock.release();
        await client.logout();
        const hasMore = (offset + messages.length) < total;
        const listResult = { value: messages, total, offset, hasMore };
        setCached(listCache, `list:${folder}:${top}:${offset}`, listResult);
        try { await l2Set(`list:${folder}:${top}:${offset}`, listResult); } catch {}
        return new Response(JSON.stringify(listResult), { headers: { ...headers, "X-Cache": "miss" } });
      } catch (err) {
        lock.release();
        throw err;
      }
    }

    // ── MARK READ/UNREAD (Yahoo) ──
    if (path === "/mail/read" && req.method === "PATCH") {
      invalidateListCache();
      bodyCache.clear(); // isRead state changed for this message
      const body = await req.json();
      const { id: msgId, isRead, folder } = body;
      if (!msgId) {
        return new Response(JSON.stringify({ error: "Missing id" }), { status: 400, headers });
      }
      const folderMap: Record<string, string> = {
        inbox: "INBOX", sent: "Sent", sentitems: "Sent",
        drafts: "Draft", trash: "Trash",
      };
      const mailbox = folderMap[folder || "inbox"] || "INBOX";
      client = await getImapClient();
      const lock = await client.getMailboxLock(mailbox);
      try {
        if (isRead) {
          await client.messageFlagsAdd(String(msgId), ["\\Seen"], { uid: true });
        } else {
          await client.messageFlagsRemove(String(msgId), ["\\Seen"], { uid: true });
        }
        lock.release();
        await client.logout();
        return new Response(JSON.stringify({ success: true }), { headers });
      } catch (err) {
        lock.release();
        throw err;
      }
    }

    // ── DELETE / TRASH EMAIL ──
    if (path === "/mail" && req.method === "DELETE") {
      invalidateListCache();
      bodyCache.clear();
      const msgId = url.searchParams.get("id");
      const folder = url.searchParams.get("folder") || "inbox";
      if (!msgId)
        return new Response(
          JSON.stringify({ error: "Missing message id" }),
          { status: 400, headers }
        );

      // Map incoming folder param to Yahoo mailbox name
      const folderMap: Record<string, string> = {
        inbox: "INBOX", sent: "Sent", sentitems: "Sent",
        drafts: "Draft", trash: "Trash",
      };
      const sourceMailbox = folderMap[folder] || "INBOX";
      // If already in Trash OR deleting a Draft, permanently delete
      const permanent = sourceMailbox === "Trash" || sourceMailbox === "Draft";

      client = await getImapClient();
      const lock = await client.getMailboxLock(sourceMailbox);
      try {
        if (permanent) {
          // Flag as deleted and expunge — permanent removal
          await client.messageFlagsAdd(String(msgId), ["\\Deleted"], { uid: true });
          try { await client.messageDelete(String(msgId), { uid: true }); } catch (e) {}
          lock.release();
          await client.logout();
          return new Response(
            JSON.stringify({ success: true, message: "Email permanently deleted" }),
            { headers }
          );
        } else {
          // Move to Trash
          await client.messageMove(String(msgId), "Trash", { uid: true });
          lock.release();
          await client.logout();
          return new Response(
            JSON.stringify({ success: true, message: "Email moved to Trash" }),
            { headers }
          );
        }
      } catch (err) {
        lock.release();
        // Fallback: flag as deleted in source folder
        try {
          const lock2 = await client.getMailboxLock(sourceMailbox);
          await client.messageFlagsAdd(String(msgId), ["\\Deleted"], { uid: true });
          try { await client.messageDelete(String(msgId), { uid: true }); } catch (e) {}
          lock2.release();
          await client.logout();
          return new Response(
            JSON.stringify({ success: true, message: "Email deleted" }),
            { headers }
          );
        } catch (e2) {
          throw err;
        }
      }
    }

    // ── SEND EMAIL VIA SMTP ──
    if (path === "/mail/send" && req.method === "POST") {
      invalidateListCache(); // Sent folder contents changed
      const { createTransport } = await import("nodemailer");
      const email = Netlify.env.get("YAHOO_EMAIL") || "";
      const appPassword = Netlify.env.get("YAHOO_APP_PASSWORD") || "";
      const body = await req.json();
      const { to, cc, bcc, subject, content, contentType } = body;
      if (!to || !content) {
        return new Response(JSON.stringify({ error: "Missing to or content" }), { status: 400, headers });
      }
      const toList = Array.isArray(to) ? to : [to];
      const ccList = Array.isArray(cc) ? cc.filter(Boolean) : (cc ? [cc] : []);
      const bccList = Array.isArray(bcc) ? bcc.filter(Boolean) : (bcc ? [bcc] : []);
      const transporter = createTransport({
        host: "smtp.mail.yahoo.com",
        port: 465,
        secure: true,
        auth: { user: email, pass: appPassword },
      });
      await transporter.sendMail({
        from: `"Dr. David Hatami" <${email}>`,
        to: toList.join(", "),
        ...(ccList.length ? { cc: ccList.join(", ") } : {}),
        ...(bccList.length ? { bcc: bccList.join(", ") } : {}),
        subject: subject || "(No subject)",
        ...(contentType === "HTML" ? { html: content } : { text: content }),
      });
      return new Response(JSON.stringify({ success: true, message: "Email sent via Yahoo SMTP" }), { status: 200, headers });
    }

    return new Response(
      JSON.stringify({ error: "Unknown Yahoo endpoint" }),
      { status: 404, headers }
    );
  } catch (err) {
    if (client) {
      try {
        await client.logout();
      } catch (e) {}
    }
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers,
    });
  }
};

export const config: Config = {
  path: ["/api/yahoo", "/api/yahoo/*"],
};
