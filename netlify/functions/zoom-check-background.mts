import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

/**
 * Zoom Auto-Processor — Background Scheduled Function
 *
 * Runs every 15 minutes. Checks for new Zoom cloud recordings
 * with transcripts that haven't been processed yet.
 *
 * Pipeline:
 *   1. Fetch recent recordings from Zoom API
 *   2. Compare against processed list (Netlify Blobs)
 *   3. For each unprocessed recording with a transcript:
 *      a. Fetch the VTT transcript
 *      b. Send to Claude AI for extraction
 *      c. Create tasks with status "review" (pending your approval)
 *      d. Mark recording as processed
 *
 * Tasks created have:
 *   - status: "review" (new queue status — won't clutter active tasks)
 *   - category: "Zoom Auto-Extract"
 *   - description: includes meeting name, date, owner, deadline
 *   - priority: AI-determined based on urgency language
 */

// ── ZOOM TOKEN ──
async function getZoomToken(): Promise<string> {
  const accountId = Netlify.env.get("ZOOM_ACCOUNT_ID");
  const clientId = Netlify.env.get("ZOOM_CLIENT_ID");
  const clientSecret = Netlify.env.get("ZOOM_CLIENT_SECRET");

  if (!accountId || !clientId || !clientSecret) {
    throw new Error("Zoom credentials not configured");
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

  if (!resp.ok) throw new Error(`Zoom token error: ${await resp.text()}`);
  const data = await resp.json();
  return data.access_token;
}

// ── MAIN PROCESSOR ──
export default async (req: Request) => {
  console.log("[ZOOM-AUTO] Starting transcript scan...");

  const zoomToken = await getZoomToken();
  const anthropicKey = Netlify.env.get("ANTHROPIC_API_KEY");

  if (!anthropicKey) {
    console.log("[ZOOM-AUTO] No Anthropic API key — skipping AI processing");
    return;
  }

  // 1. Get processed recordings list from Blobs
  const store = getStore({ name: "zoom-processed", consistency: "strong" });
  let processedIds: string[] = [];
  try {
    const data = await store.get("processed-list", { type: "json" });
    processedIds = (data as string[]) || [];
  } catch (e) {
    processedIds = [];
  }

  // 2. Fetch recent recordings (last 7 days)
  const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];
  const to = new Date().toISOString().split("T")[0];

  const recResp = await fetch(
    `https://api.zoom.us/v2/users/me/recordings?from=${from}&to=${to}&page_size=30`,
    { headers: { Authorization: `Bearer ${zoomToken}` } }
  );

  if (!recResp.ok) {
    console.log("[ZOOM-AUTO] Failed to fetch recordings:", recResp.status);
    return;
  }

  const recData = await recResp.json();
  const recordings = recData.meetings || [];
  console.log(`[ZOOM-AUTO] Found ${recordings.length} recordings`);

  // 3. Filter to unprocessed recordings that have transcripts
  const unprocessed = recordings.filter((rec: any) => {
    if (processedIds.includes(String(rec.id))) return false;
    const hasTranscript = (rec.recording_files || []).some(
      (f: any) =>
        f.file_type === "TRANSCRIPT" ||
        f.recording_type === "audio_transcript" ||
        f.file_extension === "VTT"
    );
    return hasTranscript;
  });

  console.log(`[ZOOM-AUTO] ${unprocessed.length} unprocessed with transcripts`);

  if (unprocessed.length === 0) {
    console.log("[ZOOM-AUTO] Nothing to process. Done.");
    return;
  }

  // 4. Process each one
  const taskStore = getStore({ name: "sam-tasks", consistency: "strong" });

  for (const rec of unprocessed) {
    try {
      console.log(`[ZOOM-AUTO] Processing: ${rec.topic} (${rec.id})`);

      // 4a. Get full recording details with download URLs
      const detailResp = await fetch(
        `https://api.zoom.us/v2/meetings/${rec.id}/recordings`,
        { headers: { Authorization: `Bearer ${zoomToken}` } }
      );
      if (!detailResp.ok) {
        console.log(`[ZOOM-AUTO] Failed to get details for ${rec.id}`);
        continue;
      }
      const detail = await detailResp.json();

      // 4b. Find and download transcript
      const transcriptFile = (detail.recording_files || []).find(
        (f: any) =>
          f.file_type === "TRANSCRIPT" ||
          f.recording_type === "audio_transcript" ||
          f.file_extension === "VTT"
      );

      if (!transcriptFile?.download_url) {
        console.log(`[ZOOM-AUTO] No transcript download URL for ${rec.id}`);
        continue;
      }

      const dlResp = await fetch(
        `${transcriptFile.download_url}?access_token=${zoomToken}`
      );
      if (!dlResp.ok) {
        console.log(`[ZOOM-AUTO] Failed to download transcript for ${rec.id}`);
        continue;
      }

      const vttText = await dlResp.text();

      // Parse VTT to plain text
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

      if (plainText.length < 50) {
        console.log(`[ZOOM-AUTO] Transcript too short for ${rec.id}, skipping`);
        processedIds.push(String(rec.id));
        continue;
      }

      // 4c. Send to AI for extraction — Gemini Flash (free) first, Claude fallback
      const geminiKey = Netlify.env.get("GEMINI_API_KEY");
      const extractPrompt = `Extract all action items from this Zoom meeting transcript. Return ONLY valid JSON, no markdown fences, no preamble. Format: {"summary":"3 sentence summary","action_items":[{"task":"specific action","owner":"person name or Unknown","deadline":"date or ASAP or null","priority":"urgent|high|normal|low"}],"decisions":["decision made"],"follow_ups":["item needing follow up"]}\n\nMeeting: ${rec.topic || "Unknown Meeting"}\nDate: ${rec.start_time || ""}\nDuration: ${rec.duration || 0} minutes\n\nTranscript (first 6000 chars):\n${plainText.substring(0, 6000)}`;

      let aiText = "";

      if (geminiKey) {
        // Use Gemini Flash — free tier, fast, great for extraction
        try {
          const gResp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                system_instruction: { parts: [{ text: "You extract action items from meeting transcripts. Return ONLY valid JSON." }] },
                contents: [{ role: "user", parts: [{ text: extractPrompt }] }],
                generationConfig: { maxOutputTokens: 2000, temperature: 0.3 },
              }),
            }
          );
          if (gResp.ok) {
            const gData = await gResp.json();
            aiText = gData.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "";
            console.log(`[ZOOM-AUTO] Gemini Flash processed ${rec.id} (free)`);
          }
        } catch (e) {
          console.log(`[ZOOM-AUTO] Gemini failed for ${rec.id}, trying Claude`);
        }
      }

      // Fallback to Claude if Gemini didn't produce output
      if (!aiText && anthropicKey) {
        const aiResp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "claude-opus-4-6",
            max_tokens: 2000,
            system: "You extract action items from meeting transcripts. Return ONLY valid JSON, no markdown fences, no preamble.",
            messages: [{ role: "user", content: extractPrompt }],
          }),
        });
        if (aiResp.ok) {
          const aiData = await aiResp.json();
          aiText = aiData.content?.[0]?.text || "";
          console.log(`[ZOOM-AUTO] Claude processed ${rec.id} (fallback)`);
        } else {
          console.log(`[ZOOM-AUTO] Claude API error for ${rec.id}:`, aiResp.status);
          continue;
        }
      }

      if (!aiText) {
        console.log(`[ZOOM-AUTO] No AI response for ${rec.id}, skipping`);
        continue;
      }

      // 4d. Parse AI response
      let parsed: any;
      try {
        const jsonMatch = aiText.match(/\{[\s\S]*\}/);
        parsed = jsonMatch
          ? JSON.parse(jsonMatch[0])
          : { summary: aiText, action_items: [], decisions: [], follow_ups: [] };
      } catch (e) {
        parsed = {
          summary: aiText,
          action_items: [],
          decisions: [],
          follow_ups: [],
        };
      }

      console.log(
        `[ZOOM-AUTO] Extracted ${parsed.action_items?.length || 0} action items from ${rec.topic}`
      );

      // 4e. Create tasks for each action item with status "review"
      const meetingDate = rec.start_time
        ? new Date(rec.start_time).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })
        : "";

      let taskCount = 0;
      for (const item of parsed.action_items || []) {
        const taskId = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
        const newTask = {
          id: taskId,
          title: item.task || "Zoom action item",
          description: `From Zoom: "${rec.topic || "Meeting"}" (${meetingDate})\nOwner: ${item.owner || "Unassigned"}\nSummary: ${parsed.summary || ""}\n\nAuto-extracted by SAM`,
          priority: item.priority || "normal",
          status: "review",
          category: "Zoom Auto-Extract",
          dueDate: item.deadline && item.deadline !== "null" && item.deadline !== "ASAP"
            ? item.deadline
            : "",
          notes: "",
          subtasks: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await taskStore.setJSON(taskId, newTask);
        taskCount++;
      }

      // Also create follow-up tasks
      for (const followUp of parsed.follow_ups || []) {
        const taskId = Date.now().toString(36) + Math.random().toString(36).substring(2, 8) + "f";
        const newTask = {
          id: taskId,
          title: "Follow up: " + followUp,
          description: `From Zoom: "${rec.topic || "Meeting"}" (${meetingDate})\nAuto-extracted by SAM`,
          priority: "normal",
          status: "review",
          category: "Zoom Auto-Extract",
          dueDate: "",
          notes: "",
          subtasks: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await taskStore.setJSON(taskId, newTask);
        taskCount++;
      }

      // Mark as processed — save IMMEDIATELY so a mid-loop crash doesn't re-process this
      // recording on the next 15-min tick (which would create duplicate tasks). Previously
      // processed-list was saved only at the end, so any partial progress was lost.
      processedIds.push(String(rec.id));
      try {
        await store.setJSON("processed-list", processedIds);
      } catch (e) {
        console.log(`[ZOOM-AUTO] Failed to checkpoint processed-list after ${rec.id}:`, String(e));
      }
      console.log(
        `[ZOOM-AUTO] Created ${(parsed.action_items?.length || 0) + (parsed.follow_ups?.length || 0)} review tasks from ${rec.topic}`
      );
    } catch (err) {
      console.log(`[ZOOM-AUTO] Error processing ${rec.id}:`, String(err));
    }
  }

  // 5. Final checkpoint (redundant if loop completed cleanly, but catches the early-short-transcript path)
  await store.setJSON("processed-list", processedIds);
  console.log(
    `[ZOOM-AUTO] Done. Processed ${unprocessed.length} recordings. Total processed: ${processedIds.length}`
  );
};

export const config: Config = {
  schedule: "*/15 * * * *", // Every 15 minutes
};
