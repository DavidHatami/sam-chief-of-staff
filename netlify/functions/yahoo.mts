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

// Module-level cache — survives across invocations within the same warm Lambda instance.
// Yahoo IMAP has high fixed latency per connection (~500-1000ms TLS + auth), so even
// short TTLs dramatically improve perceived speed when the user refreshes or navigates
// back to the email tab within a minute.
type CacheEntry = { timestamp: number; data: any };
const LIST_TTL_MS = 30000;   // 30s for list views
const BODY_TTL_MS = 300000;  // 5min for single-message bodies (bodies never change)
const listCache: Map<string, CacheEntry> = new Map();
const bodyCache: Map<string, CacheEntry> = new Map();

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
      const isPrefetch = url.searchParams.get("prefetch") === "1";

      // CACHE CHECK — short-circuit before opening IMAP connection (saves 500-1000ms TLS handshake + auth)
      if (msgId) {
        const cacheKey = `body:${msgId}`;
        const cached = getCached(bodyCache, cacheKey, BODY_TTL_MS);
        if (cached) {
          // If not a prefetch, also fire a background mark-as-read since cache hit skipped server
          if (!isPrefetch && !cached.isRead) {
            // Don't await — fire-and-forget
            (async () => {
              try {
                const c = await getImapClient();
                const l = await c.getMailboxLock(folderMap_static(folder));
                try { await c.messageFlagsAdd(String(msgId), ["\\Seen"], { uid: true }); } catch (e) {}
                l.release();
                await c.logout();
              } catch (e) {}
            })();
            cached.isRead = true;
          }
          return new Response(JSON.stringify(cached), { headers: { ...headers, "X-Cache": "hit" } });
        }
      } else {
        const cacheKey = `list:${folder}:${top}`;
        const cached = getCached(listCache, cacheKey, LIST_TTL_MS);
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
          // Write body to cache
          setCached(bodyCache, `body:${String(uid)}`, result);
          // If we marked as read, invalidate list cache (isRead count changed)
          if (!isPrefetch) invalidateListCache();
          return new Response(JSON.stringify(result), { headers: { ...headers, "X-Cache": "miss" } });
        }

        // List messages
        const messages: EmailMsg[] = [];
        let count = 0;

        // Get message sequence range (latest N messages)
        const status = await client.status(mailbox, { messages: true });
        const total = status.messages || 0;
        if (total === 0) {
          lock.release();
          await client.logout();
          return new Response(JSON.stringify({ value: [] }), { headers });
        }
        const startSeq = Math.max(1, total - top + 1);

        // Fetch in reverse order (newest first) — envelope+flags only, no body
        for await (const msg of client.fetch(`${startSeq}:*`, {
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
        const listResult = { value: messages };
        setCached(listCache, `list:${folder}:${top}`, listResult);
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
