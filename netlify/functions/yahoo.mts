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

      client = await getImapClient();

      const mailbox =
        folder === "sentitems" || folder === "sent" ? "Sent" : "INBOX";
      const lock = await client.getMailboxLock(mailbox);

      try {
        // Single message — full body
        if (msgId) {
          const uid = parseInt(msgId);
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
            isRead: true,
            bodyPreview: parsed.text?.substring(0, 300) || "",
            body: {
              contentType: parsed.html ? "html" : "Text",
              content: (parsed.html as string) || parsed.text || "",
            },
            toRecipients,
          };

          // Mark as seen
          try {
            await client.messageFlagsAdd(String(uid), ["\\Seen"], {
              uid: true,
            });
          } catch (e) {}

          lock.release();
          await client.logout();
          return new Response(JSON.stringify(result), { headers });
        }

        // List messages
        const messages: EmailMsg[] = [];
        let count = 0;

        // Get message sequence range (latest N messages)
        const status = await client.status(mailbox, { messages: true });
        const total = status.messages || 0;
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
        return new Response(JSON.stringify({ value: messages }), { headers });
      } catch (err) {
        lock.release();
        throw err;
      }
    }

    // ── DELETE / TRASH EMAIL ──
    if (path === "/mail" && req.method === "DELETE") {
      const msgId = url.searchParams.get("id");
      if (!msgId)
        return new Response(
          JSON.stringify({ error: "Missing message id" }),
          { status: 400, headers }
        );

      client = await getImapClient();
      const lock = await client.getMailboxLock("INBOX");
      try {
        // Move to Trash
        await client.messageMove(String(msgId), "Trash", { uid: true });
        lock.release();
        await client.logout();
        return new Response(
          JSON.stringify({ success: true, message: "Email moved to Trash" }),
          { headers }
        );
      } catch (err) {
        lock.release();
        // If move fails, try flagging as deleted
        try {
          const lock2 = await client.getMailboxLock("INBOX");
          await client.messageFlagsAdd(String(msgId), ["\\Deleted"], {
            uid: true,
          });
          await client.messageDelete(String(msgId), { uid: true });
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
