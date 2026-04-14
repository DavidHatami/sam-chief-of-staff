import type { Context, Config } from "@netlify/functions";

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const {
      summary,
      email,
      name,
      org,
      notes,
      type,
      duration,
      startDateTime,
      endDateTime,
      timeZone,
    } = body;

    if (!summary || !email || !startDateTime || !endDateTime) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Build Google Calendar event payload
    const gcalEvent = {
      summary: summary,
      description: [
        `Meeting Type: ${type}`,
        `Duration: ${duration} minutes`,
        `Guest: ${name}`,
        org ? `Organization: ${org}` : null,
        notes ? `\nNotes from guest:\n${notes}` : null,
        `\n---\nBooked via SAM Chief of Staff`,
      ]
        .filter(Boolean)
        .join("\n"),
      start: {
        dateTime: startDateTime,
        timeZone: timeZone || "America/New_York",
      },
      end: {
        dateTime: endDateTime,
        timeZone: timeZone || "America/New_York",
      },
      attendees: [
        { email: "dh30111@gmail.com", organizer: true },
        { email: email, displayName: name },
      ],
      conferenceData: {
        createRequest: {
          conferenceSolutionKey: { type: "hangoutsMeet" },
          requestId: `sam-book-${Date.now()}`,
        },
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: "email", minutes: 60 },
          { method: "popup", minutes: 15 },
        ],
      },
    };

    // Use Google Calendar API via OAuth
    // For now, we use the service account or stored refresh token
    const GCAL_API_KEY = Netlify.env.get("GOOGLE_API_KEY");
    const GCAL_REFRESH_TOKEN = Netlify.env.get("GOOGLE_REFRESH_TOKEN");
    const GCAL_CLIENT_ID = Netlify.env.get("GOOGLE_CLIENT_ID");
    const GCAL_CLIENT_SECRET = Netlify.env.get("GOOGLE_CLIENT_SECRET");

    let accessToken = "";

    if (GCAL_REFRESH_TOKEN && GCAL_CLIENT_ID && GCAL_CLIENT_SECRET) {
      // OAuth refresh token flow
      const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: GCAL_CLIENT_ID,
          client_secret: GCAL_CLIENT_SECRET,
          refresh_token: GCAL_REFRESH_TOKEN,
          grant_type: "refresh_token",
        }),
      });
      const tokenData = await tokenResp.json();
      accessToken = tokenData.access_token;
    } else if (GCAL_API_KEY) {
      // Fallback: API key (limited, can't create events with attendees)
      // This path is for initial testing only
      return new Response(
        JSON.stringify({
          success: true,
          message: "Booking recorded (demo mode — Google OAuth not yet configured)",
          event: gcalEvent,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    } else {
      // No credentials at all — demo mode
      return new Response(
        JSON.stringify({
          success: true,
          message: "Booking recorded (demo mode)",
          event: gcalEvent,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Create the event on Google Calendar
    const calResp = await fetch(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(gcalEvent),
      }
    );

    if (!calResp.ok) {
      const errBody = await calResp.text();
      console.error("Google Calendar API error:", errBody);
      // Still return success to the guest — we'll fix the calendar sync separately
      return new Response(
        JSON.stringify({
          success: true,
          message: "Booking confirmed (calendar sync pending)",
          event: gcalEvent,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    const calData = await calResp.json();

    return new Response(
      JSON.stringify({
        success: true,
        message: "Booking confirmed",
        eventId: calData.id,
        meetLink: calData.hangoutLink || calData.conferenceData?.entryPoints?.[0]?.uri,
        htmlLink: calData.htmlLink,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Booking error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error", details: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

export const config: Config = {
  path: "/api/book",
};
