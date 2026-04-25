import type { Context, Config } from "@netlify/functions";

/**
 * M365 / Outlook Integration for SAM
 * 
 * This function proxies requests to Microsoft Graph API.
 * It handles OAuth token refresh and provides endpoints for:
 *   - GET /api/m365/mail       → Read inbox
 *   - POST /api/m365/mail/send → Send email
 *   - GET /api/m365/calendar   → Read M365 calendar events
 * 
 * REQUIRED ENV VARS (set in Netlify):
 *   M365_TENANT_ID
 *   M365_CLIENT_ID
 *   M365_CLIENT_SECRET
 *   M365_USER_EMAIL (your Outlook email address)
 */

async function getM365Token(): Promise<string> {
  const tenantId = Netlify.env.get("M365_TENANT_ID");
  const clientId = Netlify.env.get("M365_CLIENT_ID");
  const clientSecret = Netlify.env.get("M365_CLIENT_SECRET");

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("M365 credentials not configured. Set M365_TENANT_ID, M365_CLIENT_ID, M365_CLIENT_SECRET in Netlify env vars.");
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`M365 token error: ${err}`);
  }

  const data = await resp.json();
  return data.access_token;
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const path = url.pathname.replace("/api/m365", "");

  try {
    const token = await getM365Token();
    const userEmail = Netlify.env.get("M365_USER_EMAIL") || "";
    const graphBase = `https://graph.microsoft.com/v1.0/users/${userEmail}`;

    // ── DELETE / TRASH EMAIL ──
    if (path === "/mail" && req.method === "DELETE") {
      const msgId = url.searchParams.get("id");
      if (!msgId) {
        return new Response(JSON.stringify({ error: "Missing message id" }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
      // Move to Deleted Items folder
      const resp = await fetch(`${graphBase}/messages/${msgId}/move`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ destinationId: "deleteditems" }),
      });
      if (!resp.ok) {
        const err = await resp.text();
        return new Response(JSON.stringify({ error: err }), {
          status: resp.status, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true, message: "Email moved to Deleted Items" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── READ MAIL ──
    if (path === "/mail" && req.method === "GET") {
      const top = url.searchParams.get("top") || "20";
      const skip = parseInt(url.searchParams.get("skip") || "0");
      const folder = url.searchParams.get("folder") || "inbox";
      const msgId = url.searchParams.get("id");

      // Single message with full body
      if (msgId) {
        const isPrefetch = url.searchParams.get("prefetch") === "1";
        const resp = await fetch(
          `${graphBase}/messages/${msgId}?$select=subject,from,toRecipients,receivedDateTime,isRead,body,bodyPreview`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!resp.ok) {
          const errText = await resp.text();
          return new Response(JSON.stringify({ error: `M365 read failed: ${errText.substring(0, 200)}` }), {
            status: resp.status, headers: { "Content-Type": "application/json" },
          });
        }
        const data = await resp.json();
        // Mark as read ONLY on real read, not prefetch
        if (!isPrefetch) {
          fetch(`${graphBase}/messages/${msgId}`, {
            method: "PATCH",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ isRead: true }),
          }).catch(() => {});
        }
        return new Response(JSON.stringify(data), {
          headers: { "Content-Type": "application/json" },
        });
      }

      const skipParam = skip > 0 ? `&$skip=${skip}` : "";
      const resp = await fetch(
        `${graphBase}/mailFolders/${folder}/messages?$top=${top}&$select=subject,from,receivedDateTime,isRead,bodyPreview&$orderby=receivedDateTime DESC${skipParam}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!resp.ok) {
        const errText = await resp.text();
        return new Response(JSON.stringify({ error: `M365 list failed: ${errText.substring(0, 200)}` }), {
          status: resp.status, headers: { "Content-Type": "application/json" },
        });
      }
      const data = await resp.json();
      // Augment with pagination metadata so frontend knows whether to show "Load older"
      const valueLen = Array.isArray(data.value) ? data.value.length : 0;
      const hasMore = valueLen >= parseInt(top);
      return new Response(JSON.stringify({ ...data, offset: skip, hasMore }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── MARK READ/UNREAD ──
    if (path === "/mail/read" && req.method === "PATCH") {
      const body = await req.json();
      const { id: msgId, isRead } = body;
      if (!msgId) {
        return new Response(JSON.stringify({ error: "Missing message id" }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      const resp = await fetch(`${graphBase}/messages/${msgId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ isRead }),
      });
      if (!resp.ok) {
        const err = await resp.text();
        return new Response(JSON.stringify({ error: err }), { status: resp.status, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
    }

    // ── SEND EMAIL ──
    if (path === "/mail/send" && req.method === "POST") {
      const body = await req.json();
      const { to, cc, bcc, subject, content, contentType } = body;

      const message: Record<string, unknown> = {
        message: {
          subject,
          body: { contentType: contentType || "Text", content },
          toRecipients: (Array.isArray(to) ? to : [to]).map((email: string) => ({
            emailAddress: { address: email },
          })),
        },
        saveToSentItems: true,
      };
      // Add CC
      const ccList = Array.isArray(cc) ? cc.filter(Boolean) : (cc ? [cc] : []);
      if (ccList.length) {
        (message.message as any).ccRecipients = ccList.map((email: string) => ({ emailAddress: { address: email } }));
      }
      // Add BCC
      const bccList = Array.isArray(bcc) ? bcc.filter(Boolean) : (bcc ? [bcc] : []);
      if (bccList.length) {
        (message.message as any).bccRecipients = bccList.map((email: string) => ({ emailAddress: { address: email } }));
      }

      const resp = await fetch(`${graphBase}/sendMail`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(message),
      });

      if (!resp.ok && resp.status !== 202) {
        const err = await resp.text();
        return new Response(JSON.stringify({ error: err }), { status: resp.status });
      }

      return new Response(JSON.stringify({ success: true, message: "Email sent" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── DELETE CALENDAR EVENT ──
    if (path === "/calendar" && req.method === "DELETE") {
      const eventId = url.searchParams.get("id");
      if (!eventId) return new Response(JSON.stringify({ error: "Missing event id" }), { status: 400, headers: { "Content-Type": "application/json" } });
      const resp = await fetch(`${graphBase}/events/${eventId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok && resp.status !== 204) {
        const err = await resp.text();
        return new Response(JSON.stringify({ error: err }), { status: resp.status, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ success: true, message: "Event deleted from M365" }), { headers: { "Content-Type": "application/json" } });
    }

    // ── UPDATE CALENDAR EVENT ──
    if (path === "/calendar" && req.method === "PATCH") {
      const body = await req.json();
      const { id: eventId, subject, start, end, location } = body;
      if (!eventId) return new Response(JSON.stringify({ error: "Missing event id" }), { status: 400, headers: { "Content-Type": "application/json" } });
      const update: Record<string, unknown> = {};
      if (subject) update.subject = subject;
      if (start) update.start = { dateTime: start, timeZone: "Eastern Standard Time" };
      if (end) update.end = { dateTime: end, timeZone: "Eastern Standard Time" };
      if (location !== undefined) update.location = { displayName: location };
      const resp = await fetch(`${graphBase}/events/${eventId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });
      if (!resp.ok) {
        const err = await resp.text();
        return new Response(JSON.stringify({ error: err }), { status: resp.status, headers: { "Content-Type": "application/json" } });
      }
      const data = await resp.json();
      return new Response(JSON.stringify({ success: true, event: { id: data.id, subject: data.subject } }), { headers: { "Content-Type": "application/json" } });
    }

    // ── READ M365 CALENDAR ──
    if (path === "/calendar" && req.method === "GET") {
      const start = url.searchParams.get("start") || new Date().toISOString();
      const end =
        url.searchParams.get("end") ||
        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      const resp = await fetch(
        `${graphBase}/calendarView?startDateTime=${start}&endDateTime=${end}&$select=subject,start,end,location,organizer,attendees,isOnlineMeeting&$orderby=start/dateTime&$top=50`,
        { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="Eastern Standard Time"' } }
      );
      if (!resp.ok) {
        const errText = await resp.text();
        return new Response(JSON.stringify({ error: `M365 calendar failed: ${errText.substring(0, 200)}` }), {
          status: resp.status, headers: { "Content-Type": "application/json" },
        });
      }
      const data = await resp.json();
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── CREATE CALENDAR EVENT ──
    if (path === "/calendar" && req.method === "POST") {
      const body = await req.json();
      const { subject, start, end, location, attendees, body: eventBody } = body;

      const event: Record<string, unknown> = {
        subject: subject || "New Event",
        start: { dateTime: start, timeZone: "Eastern Standard Time" },
        end: { dateTime: end, timeZone: "Eastern Standard Time" },
      };
      if (location) event.location = { displayName: location };
      if (eventBody) event.body = { contentType: "Text", content: eventBody };
      if (attendees && Array.isArray(attendees) && attendees.length > 0) {
        event.attendees = attendees.map((email: string) => ({
          emailAddress: { address: email },
          type: "required",
        }));
      }

      const resp = await fetch(`${graphBase}/events`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(event),
      });

      if (!resp.ok) {
        const err = await resp.text();
        return new Response(JSON.stringify({ error: err }), { status: resp.status, headers: { "Content-Type": "application/json" } });
      }

      const data = await resp.json();
      return new Response(JSON.stringify({ success: true, event: { id: data.id, subject: data.subject, start: data.start, end: data.end } }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown M365 endpoint" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

export const config: Config = {
  path: "/api/m365/*",
};
