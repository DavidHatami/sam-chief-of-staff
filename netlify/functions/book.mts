import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

/**
 * SAM Booking — Full Auto-Chain
 *
 * POST /api/book → One booking triggers 5 systems:
 *   1. Zoom meeting created (with cloud recording)
 *   2. M365 Calendar event (with Zoom link)
 *   3. Google Calendar event (with Zoom link)
 *   4. Prep task created in task store
 *   5. Confirmation emails via Resend (client + admin)
 */

async function getZoomToken(): Promise<string> {
  const accountId = Netlify.env.get("ZOOM_ACCOUNT_ID");
  const clientId = Netlify.env.get("ZOOM_CLIENT_ID");
  const clientSecret = Netlify.env.get("ZOOM_CLIENT_SECRET");
  if (!accountId || !clientId || !clientSecret) throw new Error("Zoom credentials missing");
  const resp = await fetch("https://zoom.us/oauth/token", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(clientId + ":" + clientSecret), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "account_credentials", account_id: accountId }),
  });
  if (!resp.ok) throw new Error("Zoom token error");
  return (await resp.json()).access_token;
}

async function getM365Token(): Promise<string> {
  const tenantId = Netlify.env.get("M365_TENANT_ID");
  const clientId = Netlify.env.get("M365_CLIENT_ID");
  const clientSecret = Netlify.env.get("M365_CLIENT_SECRET");
  if (!tenantId || !clientId || !clientSecret) throw new Error("M365 credentials missing");
  const resp = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret, scope: "https://graph.microsoft.com/.default" }),
  });
  if (!resp.ok) throw new Error("M365 token error");
  return (await resp.json()).access_token;
}

async function getGoogleToken(): Promise<string> {
  const clientId = Netlify.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Netlify.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Netlify.env.get("G_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Google credentials missing");
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  if (!resp.ok) throw new Error("Google token error");
  return (await resp.json()).access_token;
}

export default async (req: Request, context: Context) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST required" }), { status: 405, headers: { "Content-Type": "application/json" } });

  const headers = { "Content-Type": "application/json" };
  const results: Record<string, any> = { zoom: null, m365Cal: null, gcal: null, task: null, email: null };

  try {
    const body = await req.json();
    const { name, email, org, notes, type, duration, startDateTime, endDateTime, timeZone } = body;

    if (!name || !email || !startDateTime || !endDateTime) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400, headers });
    }

    const meetingTitle = `${type || "Meeting"} — ${name}${org ? " (" + org + ")" : ""}`;
    const dur = parseInt(duration) || 30;
    const tz = timeZone || "America/New_York";
    const startDT = new Date(startDateTime);
    const dateLabel = startDT.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: tz });
    const timeLabel = startDT.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });

    let zoomJoinUrl = "";
    let zoomPassword = "";
    let zoomMeetingId = "";

    // ── 1. CREATE ZOOM MEETING ──
    try {
      const zoomToken = await getZoomToken();
      const zoomResp = await fetch("https://api.zoom.us/v2/users/me/meetings", {
        method: "POST",
        headers: { Authorization: `Bearer ${zoomToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: meetingTitle, type: 2, start_time: startDateTime, duration: dur, timezone: tz,
          agenda: `Booked by ${name} (${email})${org ? " — " + org : ""}${notes ? "\nNotes: " + notes : ""}`,
          settings: { join_before_host: true, waiting_room: false, auto_recording: "cloud", meeting_authentication: false },
        }),
      });
      if (zoomResp.ok) {
        const zd = await zoomResp.json();
        zoomJoinUrl = zd.join_url || "";
        zoomPassword = zd.password || "";
        zoomMeetingId = String(zd.id || "");
        results.zoom = { success: true, id: zoomMeetingId, joinUrl: zoomJoinUrl };
      } else { results.zoom = { success: false, error: (await zoomResp.text()).substring(0, 100) }; }
    } catch (e) { results.zoom = { success: false, error: String(e) }; }

    const locationStr = zoomJoinUrl || "Zoom (link pending)";
    const bodyText = `${type || "Meeting"} with ${name}\n${org ? "Organization: " + org + "\n" : ""}Email: ${email}\n${notes ? "Notes: " + notes + "\n" : ""}${zoomJoinUrl ? "\nZoom: " + zoomJoinUrl : ""}${zoomPassword ? "\nPassword: " + zoomPassword : ""}\n\nBooked via SAM Chief of Staff`;

    // ── 2. CREATE M365 CALENDAR EVENT ──
    try {
      const m365Token = await getM365Token();
      const userEmail = Netlify.env.get("M365_USER_EMAIL") || "admin@edupolicy.ai";
      const m365Resp = await fetch(`https://graph.microsoft.com/v1.0/users/${userEmail}/events`, {
        method: "POST",
        headers: { Authorization: `Bearer ${m365Token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: meetingTitle,
          start: { dateTime: startDateTime, timeZone: "Eastern Standard Time" },
          end: { dateTime: endDateTime, timeZone: "Eastern Standard Time" },
          location: { displayName: locationStr },
          body: { contentType: "Text", content: bodyText },
          attendees: [{ emailAddress: { address: email, name: name }, type: "required" }],
          reminderMinutesBeforeStart: 15,
        }),
      });
      results.m365Cal = m365Resp.ok ? { success: true } : { success: false, error: (await m365Resp.text()).substring(0, 100) };
    } catch (e) { results.m365Cal = { success: false, error: String(e) }; }

    // ── 3. CREATE GOOGLE CALENDAR EVENT ──
    try {
      const gToken = await getGoogleToken();
      const gcalResp = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all", {
        method: "POST",
        headers: { Authorization: `Bearer ${gToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: meetingTitle,
          description: bodyText,
          start: { dateTime: startDateTime, timeZone: tz },
          end: { dateTime: endDateTime, timeZone: tz },
          location: locationStr,
          attendees: [{ email: email, displayName: name }],
          reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 15 }] },
        }),
      });
      results.gcal = gcalResp.ok ? { success: true } : { success: false, error: (await gcalResp.text()).substring(0, 100) };
    } catch (e) { results.gcal = { success: false, error: String(e) }; }

    // ── 4. CREATE PREP TASK ──
    try {
      const taskStore = getStore({ name: "sam-tasks", consistency: "strong" });
      const existing = (await taskStore.get("tasks", { type: "json" })) || [];
      const taskId = "task_" + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
      existing.unshift({
        id: taskId,
        title: `Prep for ${type || "Meeting"}: ${name}${org ? " (" + org + ")" : ""}`,
        description: `${dateLabel} at ${timeLabel}\n${email}${zoomJoinUrl ? "\nZoom: " + zoomJoinUrl : ""}`,
        status: "todo", priority: "high", category: "Meeting Prep",
        dueDate: startDT.toISOString().split("T")[0],
        created: new Date().toISOString(), updated: new Date().toISOString(),
        subtasks: [], notes: notes || "", source: "booking", sourceId: zoomMeetingId || null,
      });
      await taskStore.set("tasks", JSON.stringify(existing));
      results.task = { success: true, id: taskId };
    } catch (e) { results.task = { success: false, error: String(e) }; }

    // ── 5. SEND CONFIRMATION EMAILS ──
    try {
      const RESEND_KEY = Netlify.env.get("RESEND_API_KEY");
      if (RESEND_KEY) {
        const [clientResp, adminResp] = await Promise.all([
          fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: "Dr. David Hatami <booking@edupolicy.ai>",
              to: [email],
              subject: `Booking Confirmed: ${type || "Meeting"} — ${dateLabel}`,
              text: `Hi ${name},\n\nYour ${type || "meeting"} with Dr. David Hatami is confirmed.\n\nDate: ${dateLabel}\nTime: ${timeLabel} ET\nDuration: ${dur} minutes${zoomJoinUrl ? "\nZoom: " + zoomJoinUrl : ""}${zoomPassword ? "\nPassword: " + zoomPassword : ""}\n\nIf you need to reschedule, reply to this email.\n\n— SAM, Chief of Staff`,
              reply_to: "admin@edupolicy.ai",
            }),
          }),
          fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: "SAM Chief of Staff <booking@edupolicy.ai>",
              to: ["admin@edupolicy.ai"],
              subject: `New Booking: ${type || "Meeting"} — ${name} — ${dateLabel}`,
              text: `SAM — New Booking\n\n${meetingTitle}\n${dateLabel} at ${timeLabel} ET · ${dur} min\nGuest: ${name} (${email})${org ? "\nOrg: " + org : ""}${notes ? "\nNotes: " + notes : ""}${zoomJoinUrl ? "\nZoom: " + zoomJoinUrl : ""}\n\nSystems: Zoom ${results.zoom?.success ? "✓" : "✗"} · M365 Cal ${results.m365Cal?.success ? "✓" : "✗"} · Google Cal ${results.gcal?.success ? "✓" : "✗"} · Task ${results.task?.success ? "✓" : "✗"}`,
              reply_to: email,
            }),
          }),
        ]);
        results.email = { success: clientResp.ok && adminResp.ok, clientSent: clientResp.ok, adminSent: adminResp.ok };
      }
    } catch (e) { results.email = { success: false, error: String(e) }; }

    const successCount = Object.values(results).filter((r: any) => r?.success).length;
    return new Response(JSON.stringify({
      success: true,
      message: `Booking confirmed — ${successCount}/5 systems updated`,
      meetingTitle, date: dateLabel, time: timeLabel, duration: dur,
      zoomJoinUrl: zoomJoinUrl || null, zoomPassword: zoomPassword || null, results,
    }), { headers });

  } catch (err) {
    return new Response(JSON.stringify({ error: "Booking failed: " + String(err), results }), { status: 500, headers });
  }
};

export const config: Config = {
  path: "/api/book",
};
