import type { Context, Config } from "@netlify/functions";

/**
 * Zoom Integration for SAM — Phase 1
 *
 * Server-to-Server OAuth (auto token refresh)
 *
 * GET  /api/zoom/meetings              → List upcoming & recent meetings
 * GET  /api/zoom/meetings?id=X         → Single meeting details
 * POST /api/zoom/meetings              → Create a new meeting
 * GET  /api/zoom/recordings            → List cloud recordings (last 30 days)
 * GET  /api/zoom/recordings?id=X       → Single recording with download links
 * GET  /api/zoom/transcript?id=X       → Fetch VTT transcript text for a recording
 * DELETE /api/zoom/recordings?id=X     → Delete a recording
 *
 * ENV VARS:
 *   ZOOM_ACCOUNT_ID
 *   ZOOM_CLIENT_ID
 *   ZOOM_CLIENT_SECRET
 */

let cachedToken: { token: string; expires: number } | null = null;

async function getZoomToken(): Promise<string> {
  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && Date.now() < cachedToken.expires - 60000) {
    return cachedToken.token;
  }

  const accountId = Netlify.env.get("ZOOM_ACCOUNT_ID");
  const clientId = Netlify.env.get("ZOOM_CLIENT_ID");
  const clientSecret = Netlify.env.get("ZOOM_CLIENT_SECRET");

  if (!accountId || !clientId || !clientSecret) {
    throw new Error(
      "Zoom credentials not configured. Set ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET in Netlify env vars."
    );
  }

  const auth = btoa(`${clientId}:${clientSecret}`);

  const resp = await fetch("https://zoom.us/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "account_credentials",
      account_id: accountId,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Zoom token error: ${err}`);
  }

  const data = await resp.json();
  cachedToken = {
    token: data.access_token,
    expires: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

async function zoomFetch(
  path: string,
  token: string,
  options?: RequestInit
): Promise<any> {
  const resp = await fetch(`https://api.zoom.us/v2${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options?.headers || {}),
    },
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Zoom API ${resp.status}: ${err}`);
  }

  // Some endpoints return 204 No Content
  if (resp.status === 204) return { success: true };

  return resp.json();
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const path = url.pathname.replace("/api/zoom", "");
  const headers = { "Content-Type": "application/json" };

  try {
    const token = await getZoomToken();

    // ── LIST MEETINGS ──
    if (path === "/meetings" && req.method === "GET") {
      const meetingId = url.searchParams.get("id");

      // Single meeting
      if (meetingId) {
        const data = await zoomFetch(`/meetings/${meetingId}`, token);
        return new Response(JSON.stringify(data), { headers });
      }

      // List upcoming + recent (last 30 days)
      const [upcoming, recent] = await Promise.allSettled([
        zoomFetch("/users/me/meetings?type=upcoming&page_size=30", token),
        zoomFetch("/users/me/meetings?type=scheduled&page_size=30", token),
      ]);

      const upcomingMeetings =
        upcoming.status === "fulfilled" ? upcoming.value.meetings || [] : [];
      const scheduledMeetings =
        recent.status === "fulfilled" ? recent.value.meetings || [] : [];

      // Deduplicate by id
      const seen = new Set<string>();
      const allMeetings: any[] = [];
      [...upcomingMeetings, ...scheduledMeetings].forEach((m: any) => {
        if (!seen.has(String(m.id))) {
          seen.add(String(m.id));
          allMeetings.push(m);
        }
      });

      // Sort by start_time descending
      allMeetings.sort(
        (a: any, b: any) =>
          new Date(b.start_time || 0).getTime() -
          new Date(a.start_time || 0).getTime()
      );

      return new Response(
        JSON.stringify({ meetings: allMeetings }),
        { headers }
      );
    }

    // ── CREATE MEETING ──
    if (path === "/meetings" && req.method === "POST") {
      const body = await req.json();
      const {
        topic,
        start_time,
        duration,
        password,
        agenda,
        attendees,
      } = body;

      const meeting: Record<string, any> = {
        topic: topic || "SAM Meeting",
        type: 2, // Scheduled meeting
        start_time: start_time, // ISO format
        duration: duration || 30,
        timezone: "America/New_York",
        settings: {
          join_before_host: true,
          waiting_room: false,
          auto_recording: "cloud",
          meeting_authentication: false,
        },
      };

      if (password) meeting.password = password;
      if (agenda) meeting.agenda = agenda;
      if (attendees && Array.isArray(attendees) && attendees.length > 0) {
        meeting.settings.meeting_invitees = attendees.map(
          (email: string) => ({ email })
        );
      }

      const data = await zoomFetch("/users/me/meetings", token, {
        method: "POST",
        body: JSON.stringify(meeting),
      });

      return new Response(
        JSON.stringify({
          success: true,
          meeting: {
            id: data.id,
            topic: data.topic,
            start_time: data.start_time,
            duration: data.duration,
            join_url: data.join_url,
            password: data.password,
            start_url: data.start_url,
          },
        }),
        { headers }
      );
    }

    // ── LIST RECORDINGS ──
    if (path === "/recordings" && req.method === "GET") {
      const recordingId = url.searchParams.get("id");

      // Single recording
      if (recordingId) {
        const data = await zoomFetch(
          `/meetings/${recordingId}/recordings`,
          token
        );
        return new Response(JSON.stringify(data), { headers });
      }

      // List recordings from the last 30 days
      const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];
      const to = new Date().toISOString().split("T")[0];

      const data = await zoomFetch(
        `/users/me/recordings?from=${from}&to=${to}&page_size=50`,
        token
      );

      const recordings = (data.meetings || []).map((r: any) => ({
        id: r.id,
        uuid: r.uuid,
        topic: r.topic,
        start_time: r.start_time,
        duration: r.duration,
        total_size: r.total_size,
        recording_count: r.recording_count,
        share_url: r.share_url,
        recording_files: (r.recording_files || []).map((f: any) => ({
          id: f.id,
          file_type: f.file_type,
          file_extension: f.file_extension,
          file_size: f.file_size,
          recording_type: f.recording_type,
          status: f.status,
          download_url: f.download_url,
          play_url: f.play_url,
        })),
      }));

      return new Response(
        JSON.stringify({ recordings }),
        { headers }
      );
    }

    // ── DELETE RECORDING ──
    if (path === "/recordings" && req.method === "DELETE") {
      const meetingId = url.searchParams.get("id");
      if (!meetingId) {
        return new Response(
          JSON.stringify({ error: "Missing recording meeting id" }),
          { status: 400, headers }
        );
      }

      await zoomFetch(`/meetings/${meetingId}/recordings`, token, {
        method: "DELETE",
      });

      return new Response(
        JSON.stringify({ success: true, message: "Recording deleted" }),
        { headers }
      );
    }

    // ── FETCH TRANSCRIPT ──
    if (path === "/transcript" && req.method === "GET") {
      const meetingId = url.searchParams.get("id");
      if (!meetingId) {
        return new Response(
          JSON.stringify({ error: "Missing meeting id" }),
          { status: 400, headers }
        );
      }

      // Get recording files for this meeting
      const data = await zoomFetch(
        `/meetings/${meetingId}/recordings`,
        token
      );

      const files = data.recording_files || [];

      // Find the transcript file (VTT or TRANSCRIPT type)
      const transcriptFile = files.find(
        (f: any) =>
          f.file_type === "TRANSCRIPT" ||
          f.recording_type === "audio_transcript" ||
          f.file_extension === "VTT"
      );

      if (!transcriptFile || !transcriptFile.download_url) {
        return new Response(
          JSON.stringify({
            error: "No transcript found for this recording",
            available_files: files.map((f: any) => ({
              type: f.file_type,
              recording_type: f.recording_type,
              extension: f.file_extension,
            })),
          }),
          { status: 404, headers }
        );
      }

      // Download the transcript
      const dlUrl = `${transcriptFile.download_url}?access_token=${token}`;
      const dlResp = await fetch(dlUrl);

      if (!dlResp.ok) {
        return new Response(
          JSON.stringify({
            error: `Failed to download transcript: ${dlResp.status}`,
          }),
          { status: dlResp.status, headers }
        );
      }

      const vttText = await dlResp.text();

      // Parse VTT to plain text (strip timestamps)
      const plainText = vttText
        .split("\n")
        .filter(
          (line: string) =>
            line.trim() !== "" &&
            !line.startsWith("WEBVTT") &&
            !line.startsWith("NOTE") &&
            !line.match(/^\d+$/) &&
            !line.match(
              /^\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}/
            )
        )
        .join("\n")
        .trim();

      return new Response(
        JSON.stringify({
          meeting_id: meetingId,
          topic: data.topic || "",
          start_time: data.start_time || "",
          duration: data.duration || 0,
          transcript_raw: vttText,
          transcript_text: plainText,
          word_count: plainText.split(/\s+/).length,
        }),
        { headers }
      );
    }

    // ── PAST MEETINGS ──
    if (path === "/past" && req.method === "GET") {
      const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      const to = new Date().toISOString().split("T")[0];
      const resp = await zoomAPI(`/users/me/meetings?type=previous_meetings&page_size=30&from=${from}&to=${to}`, token);
      if (!resp.ok) {
        const err = await resp.text();
        return new Response(JSON.stringify({ error: err }), { status: resp.status, headers });
      }
      const data = await resp.json();
      return new Response(JSON.stringify({ meetings: data.meetings || [] }), { headers });
    }

    // ── MEETING PARTICIPANTS ──
    if (path === "/participants" && req.method === "GET") {
      const meetingId = url.searchParams.get("id");
      if (!meetingId) return new Response(JSON.stringify({ error: "Meeting ID required" }), { status: 400, headers });
      const resp = await zoomAPI(`/past_meetings/${meetingId}/participants?page_size=50`, token);
      if (!resp.ok) {
        const err = await resp.text();
        return new Response(JSON.stringify({ error: err }), { status: resp.status, headers });
      }
      const data = await resp.json();
      return new Response(JSON.stringify({ participants: data.participants || [], total: data.total_records || 0 }), { headers });
    }

    // ── INSTANT MEETING ──
    if (path === "/instant" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const topic = (body as any).topic || "Instant Meeting";
      const resp = await zoomAPI("/users/me/meetings", token, {
        method: "POST",
        body: JSON.stringify({
          topic,
          type: 1,
          settings: { join_before_host: true, auto_recording: "cloud", waiting_room: false },
        }),
      });
      if (!resp.ok) {
        const err = await resp.text();
        return new Response(JSON.stringify({ error: err }), { status: resp.status, headers });
      }
      const data = await resp.json();
      return new Response(JSON.stringify({
        success: true,
        meeting: { id: data.id, topic: data.topic, join_url: data.join_url, start_url: data.start_url, password: data.password },
      }), { headers });
    }

    // ── VIEW TRANSCRIPT INLINE ──
    if (path === "/view-transcript" && req.method === "GET") {
      const meetingId = url.searchParams.get("id");
      if (!meetingId) return new Response(JSON.stringify({ error: "Meeting ID required" }), { status: 400, headers });
      const resp = await zoomAPI(`/meetings/${meetingId}/recordings`, token);
      if (!resp.ok) return new Response(JSON.stringify({ error: "Recording not found" }), { status: 404, headers });
      const data = await resp.json();
      const transcriptFile = data.recording_files?.find(
        (f: any) => f.file_type === "TRANSCRIPT" || f.recording_type === "audio_transcript"
      );
      if (!transcriptFile) return new Response(JSON.stringify({ error: "No transcript for this recording" }), { status: 404, headers });
      const dlResp = await fetch(`${transcriptFile.download_url}?access_token=${token}`);
      if (!dlResp.ok) return new Response(JSON.stringify({ error: "Failed to download transcript" }), { status: 500, headers });
      const vttText = await dlResp.text();
      const segments: Array<{time:string;speaker:string;text:string}> = [];
      let curTime = "";
      for (const line of vttText.split("\n")) {
        const tm = line.match(/^(\d{2}:\d{2}:\d{2})\.\d{3}\s*-->/);
        if (tm) { curTime = tm[1]; continue; }
        if (line.trim() && !line.startsWith("WEBVTT") && !line.startsWith("NOTE") && !line.match(/^\d+$/) && curTime) {
          const sp = line.match(/^(.+?):\s*(.+)$/);
          segments.push(sp ? { time: curTime, speaker: sp[1].trim(), text: sp[2].trim() } : { time: curTime, speaker: "", text: line.trim() });
        }
      }
      const plainText = segments.map(s => (s.speaker ? s.speaker + ": " : "") + s.text).join("\n");
      return new Response(JSON.stringify({ topic: data.topic || "", segments, plainText, wordCount: plainText.split(/\s+/).length }), { headers });
    }

    return new Response(
      JSON.stringify({ error: "Unknown Zoom endpoint: " + path }),
      { status: 404, headers }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers,
    });
  }
};

export const config: Config = {
  path: ["/api/zoom", "/api/zoom/*"],
};
