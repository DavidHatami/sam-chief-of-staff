import type { Context, Config } from "@netlify/functions";

/**
 * Gmail Integration for SAM
 *
 * Proxies requests to Gmail API via Google OAuth2.
 * GET  /api/gmail/mail          → Read inbox or sent
 * GET  /api/gmail/mail?id=X     → Read single message
 * POST /api/gmail/mail/send     → Send email
 *
 * REQUIRED ENV VARS:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   G_REFRESH_TOKEN
 */

async function getGoogleToken(): Promise<string> {
  const clientId = Netlify.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Netlify.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Netlify.env.get("G_REFRESH_TOKEN");

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Gmail credentials not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, G_REFRESH_TOKEN in Netlify env vars.");
  }

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Google token error: ${err}`);
  }

  const data = await resp.json();
  return data.access_token;
}

function decodeBase64Url(str: string): string {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  return atob(padded);
}

function encodeBase64Url(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface GmailHeader {
  name: string;
  value: string;
}

function getHeader(headers: GmailHeader[], name: string): string {
  const h = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return h?.value || "";
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const path = url.pathname.replace("/api/gmail", "");
  const headers = { "Content-Type": "application/json" };

  try {
    const token = await getGoogleToken();
    const gmailBase = "https://gmail.googleapis.com/gmail/v1/users/me";

    // ── DELETE / TRASH EMAIL ──
    if (path === "/mail" && req.method === "DELETE") {
      const msgId = url.searchParams.get("id");
      if (!msgId) {
        return new Response(JSON.stringify({ error: "Missing message id" }), { status: 400, headers });
      }
      const resp = await fetch(`${gmailBase}/messages/${msgId}/trash`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) {
        const err = await resp.text();
        return new Response(JSON.stringify({ error: err }), { status: resp.status, headers });
      }
      return new Response(JSON.stringify({ success: true, message: "Email moved to Trash" }), { headers });
    }

    // ── LIST MESSAGES ──
    if (path === "/mail" && req.method === "GET") {
      const msgId = url.searchParams.get("id");
      const folder = url.searchParams.get("folder") || "inbox";
      const top = url.searchParams.get("top") || "30";

      // Single message
      if (msgId) {
        const resp = await fetch(
          `${gmailBase}/messages/${msgId}?format=full`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const msg = await resp.json();
        if (msg.error) return new Response(JSON.stringify({ error: msg.error.message }), { status: 400, headers });

        const hdrs = msg.payload?.headers || [];
        const subject = getHeader(hdrs, "Subject");
        const fromRaw = getHeader(hdrs, "From");
        const to = getHeader(hdrs, "To");
        const date = getHeader(hdrs, "Date");

        // Parse "Name <email>" format into M365-compatible structure
        const fromMatch = fromRaw.match(/^(.+?)\s*<(.+?)>$/);
        const fromObj = {
          emailAddress: {
            name: fromMatch ? fromMatch[1].replace(/"/g, "").trim() : fromRaw,
            address: fromMatch ? fromMatch[2] : fromRaw,
          },
        };

        // Extract body
        let bodyHtml = "";
        let bodyText = "";
        function extractParts(part: any) {
          if (part.mimeType === "text/html" && part.body?.data) {
            bodyHtml = decodeBase64Url(part.body.data);
          } else if (part.mimeType === "text/plain" && part.body?.data) {
            bodyText = decodeBase64Url(part.body.data);
          }
          if (part.parts) part.parts.forEach(extractParts);
        }
        extractParts(msg.payload);

        return new Response(JSON.stringify({
          id: msg.id,
          subject,
          from: fromObj,
          to,
          receivedDateTime: date,
          isRead: !msg.labelIds?.includes("UNREAD"),
          body: {
            contentType: bodyHtml ? "html" : "Text",
            content: bodyHtml || bodyText,
          },
          bodyPreview: msg.snippet || "",
          toRecipients: to.split(",").map((e: string) => ({
            emailAddress: { address: e.trim().replace(/.*<(.+)>/, "$1") },
          })),
        }), { headers });
      }

      // List messages
      const labelId = folder === "sentitems" || folder === "sent" ? "SENT" : "INBOX";
      const listResp = await fetch(
        `${gmailBase}/messages?labelIds=${labelId}&maxResults=${top}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const listData = await listResp.json();
      const messageIds = listData.messages || [];

      // Fetch each message's metadata (batch of headers only)
      const messages = await Promise.all(
        messageIds.slice(0, parseInt(top)).map(async (m: { id: string }) => {
          const r = await fetch(
            `${gmailBase}/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          const msg = await r.json();
          const hdrs = msg.payload?.headers || [];
          const fromRaw = getHeader(hdrs, "From");
          // Parse "Name <email>" format
          const nameMatch = fromRaw.match(/^(.+?)\s*<(.+?)>$/);
          return {
            id: msg.id,
            subject: getHeader(hdrs, "Subject") || "(no subject)",
            from: {
              emailAddress: {
                name: nameMatch ? nameMatch[1].replace(/"/g, "").trim() : fromRaw,
                address: nameMatch ? nameMatch[2] : fromRaw,
              },
            },
            receivedDateTime: getHeader(hdrs, "Date"),
            isRead: !msg.labelIds?.includes("UNREAD"),
            bodyPreview: msg.snippet || "",
          };
        })
      );

      return new Response(JSON.stringify({ value: messages }), { headers });
    }

    // ── SEND EMAIL ──
    if (path === "/mail/send" && req.method === "POST") {
      const body = await req.json();
      const { to, subject, content } = body;
      const toList = Array.isArray(to) ? to : [to];

      const rawEmail = [
        `To: ${toList.join(", ")}`,
        `Subject: ${subject}`,
        `Content-Type: text/plain; charset="UTF-8"`,
        "",
        content,
      ].join("\r\n");

      const encoded = encodeBase64Url(rawEmail);

      const resp = await fetch(`${gmailBase}/messages/send`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ raw: encoded }),
      });

      if (!resp.ok) {
        const err = await resp.text();
        return new Response(JSON.stringify({ error: err }), { status: resp.status, headers });
      }

      return new Response(JSON.stringify({ success: true, message: "Email sent via Gmail" }), { headers });
    }

    return new Response(JSON.stringify({ error: "Unknown Gmail endpoint" }), { status: 404, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers });
  }
};

export const config: Config = {
  path: ["/api/gmail", "/api/gmail/*"],
};
