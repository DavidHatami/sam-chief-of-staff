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

    // ── READ INBOX ──
    if (path === "/mail" && req.method === "GET") {
      const top = url.searchParams.get("top") || "20";
      const resp = await fetch(
        `${graphBase}/mailFolders/inbox/messages?$top=${top}&$select=subject,from,receivedDateTime,isRead,bodyPreview&$orderby=receivedDateTime DESC`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await resp.json();
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── SEND EMAIL ──
    if (path === "/mail/send" && req.method === "POST") {
      const body = await req.json();
      const { to, subject, content, contentType } = body;

      const message = {
        message: {
          subject,
          body: { contentType: contentType || "Text", content },
          toRecipients: (Array.isArray(to) ? to : [to]).map((email: string) => ({
            emailAddress: { address: email },
          })),
        },
        saveToSentItems: true,
      };

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
      const data = await resp.json();
      return new Response(JSON.stringify(data), {
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
