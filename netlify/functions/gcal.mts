import type { Context, Config } from "@netlify/functions";

/**
 * Google Calendar for SAM
 *
 * GET  /api/gcal/events       → List events (default: next 30 days)
 * GET  /api/gcal/events?start=X&end=Y → List events in range
 * POST /api/gcal/event        → Create event on Google Calendar
 *
 * Uses same Google OAuth credentials as Gmail.
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
    throw new Error("Google credentials not configured.");
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

  if (!resp.ok) throw new Error("Google token error: " + await resp.text());
  const data = await resp.json();
  return data.access_token;
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const path = url.pathname.replace("/api/gcal", "");
  const headers = { "Content-Type": "application/json" };

  try {
    const token = await getGoogleToken();

    // ── READ EVENTS ──
    if ((path === "/events" || path === "/events/") && req.method === "GET") {
      const start = url.searchParams.get("start") || new Date().toISOString();
      const end = url.searchParams.get("end") || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      const params = new URLSearchParams({
        timeMin: start,
        timeMax: end,
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "100",
        timeZone: "America/New_York",
      });

      const resp = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (!resp.ok) {
        const err = await resp.text();
        return new Response(JSON.stringify({ error: err }), { status: resp.status, headers });
      }

      const data = await resp.json();
      const items = (data.items || []).map((e: any) => ({
        id: e.id,
        subject: e.summary || "(no title)",
        start: { dateTime: e.start?.dateTime || e.start?.date },
        end: { dateTime: e.end?.dateTime || e.end?.date },
        location: e.location ? { displayName: e.location } : null,
        organizer: e.organizer,
        isAllDay: !e.start?.dateTime,
        source: "google",
      }));

      // Return in M365-compatible format so frontend can merge easily
      return new Response(JSON.stringify({ value: items }), { headers });
    }

    // ── CREATE EVENT ──
    if ((path === "/event" || path === "/event/") && req.method === "POST") {
      const body = await req.json();
      const { subject, start, end, location, body: eventBody, attendees } = body;

      const event: Record<string, unknown> = {
        summary: subject || "New Event",
        start: { dateTime: start, timeZone: "America/New_York" },
        end: { dateTime: end, timeZone: "America/New_York" },
      };
      if (location) event.location = location;
      if (eventBody) event.description = eventBody;
      if (attendees && Array.isArray(attendees) && attendees.length > 0) {
        event.attendees = attendees.map((email: string) => ({ email }));
      }

      const resp = await fetch(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(event),
        }
      );

      if (!resp.ok) {
        const err = await resp.text();
        return new Response(JSON.stringify({ error: err }), { status: resp.status, headers });
      }

      const data = await resp.json();
      return new Response(JSON.stringify({
        success: true,
        event: { id: data.id, summary: data.summary, htmlLink: data.htmlLink },
      }), { headers });
    }

    return new Response(JSON.stringify({ error: "Unknown gcal endpoint" }), { status: 404, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers });
  }
};

export const config: Config = {
  path: ["/api/gcal", "/api/gcal/*"],
};
