import { getStore } from "@netlify/blobs";

/**
 * SAM PHASE 1.2 — EMAIL TRIAGE AGENT (shared core)
 *
 * Every 20 minutes the scheduled wrapper calls `runTriage`. For each
 * M365 and Gmail message received since the last run, Claude classifies
 * it into one of six buckets and — if the bucket warrants it — drafts
 * a reply in David's voice. Results go to a blob store keyed by
 * message-id so the dashboard can surface them as a review queue.
 *
 * BUCKETS:
 *   respond_today    — client, investor, institutional. Needs reply today.
 *   respond_this_week — professional but not urgent.
 *   fyi              — worth reading, no action.
 *   newsletter       — skim or skip.
 *   spam             — junk.
 *   invoice_receipt  — transactional. File it, move on.
 *
 * BLOB STORE LAYOUT:
 *   sam-triage / <account>:<messageId>  → { id, account, from, subject,
 *                                           receivedAt, bucket, reasoning,
 *                                           draftReply, status, triagedAt }
 *   sam-triage / _cursor:m365          → ISO timestamp of last processed
 *   sam-triage / _cursor:gmail         → ISO timestamp of last processed
 */

const TZ = "America/New_York";
export const TRIAGE_BUCKETS = [
  "respond_today",
  "respond_this_week",
  "fyi",
  "newsletter",
  "spam",
  "invoice_receipt",
] as const;
export type TriageBucket = (typeof TRIAGE_BUCKETS)[number];

export interface TriageResult {
  id: string;                // blob key: "<account>:<messageId>"
  account: "m365" | "gmail";
  messageId: string;
  from: string;              // "Name <email>" or just email
  fromEmail: string;
  subject: string;
  receivedAt: string;        // ISO
  bodyPreview: string;
  bucket: TriageBucket;
  reasoning: string;         // one-sentence why
  draftReply: string | null; // only populated for respond_today / respond_this_week
  status: "pending" | "approved" | "dismissed" | "sent";
  triagedAt: string;
}

// ============================================================
// AUTH HELPERS — share with briefing-core? Yes, but duplicating keeps
// each feature independently deployable. Trade a little repetition for
// decoupling; cheap at this scale.
// ============================================================

async function getM365Token(): Promise<string | null> {
  const tenantId = Netlify.env.get("M365_TENANT_ID");
  const clientId = Netlify.env.get("M365_CLIENT_ID");
  const clientSecret = Netlify.env.get("M365_CLIENT_SECRET");
  if (!tenantId || !clientId || !clientSecret) return null;

  const resp = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    }
  );
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.access_token;
}

async function getGmailToken(): Promise<string | null> {
  const clientId = Netlify.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Netlify.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Netlify.env.get("G_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) return null;

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
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.access_token;
}

// ============================================================
// FETCH NEW MESSAGES SINCE CURSOR
// ============================================================

interface IncomingMsg {
  account: "m365" | "gmail";
  messageId: string;
  from: string;
  fromEmail: string;
  subject: string;
  receivedAt: string;
  bodyPreview: string;
}

async function fetchM365Since(sinceIso: string): Promise<IncomingMsg[]> {
  const token = await getM365Token();
  if (!token) return [];
  const userEmail = Netlify.env.get("M365_USER_EMAIL") || "";
  const url =
    `https://graph.microsoft.com/v1.0/users/${userEmail}/messages` +
    `?$filter=receivedDateTime gt ${sinceIso}` +
    `&$select=id,subject,from,receivedDateTime,bodyPreview,isRead` +
    `&$orderby=receivedDateTime desc&$top=50`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return [];
  const d = await r.json();
  return (d.value || []).map((m: any) => ({
    account: "m365" as const,
    messageId: m.id,
    from: m.from?.emailAddress?.name
      ? `${m.from.emailAddress.name} <${m.from.emailAddress.address}>`
      : m.from?.emailAddress?.address || "unknown",
    fromEmail: m.from?.emailAddress?.address || "",
    subject: m.subject || "(no subject)",
    receivedAt: m.receivedDateTime,
    bodyPreview: (m.bodyPreview || "").slice(0, 1000),
  }));
}

async function fetchGmailSince(sinceIso: string): Promise<IncomingMsg[]> {
  const token = await getGmailToken();
  if (!token) return [];
  // Gmail search: after:<unix_seconds>
  const sinceUnix = Math.floor(new Date(sinceIso).getTime() / 1000);
  const listResp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=after:${sinceUnix}&maxResults=50`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!listResp.ok) return [];
  const list = await listResp.json();
  const ids = (list.messages || []).map((m: any) => m.id);
  if (!ids.length) return [];

  const details = await Promise.all(
    ids.map(async (id: string) => {
      const r = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!r.ok) return null;
      const m = await r.json();
      const headers = m.payload?.headers || [];
      const h = (n: string) => headers.find((x: any) => x.name === n)?.value || "";
      const fromRaw = h("From");
      const emailMatch = fromRaw.match(/<([^>]+)>/);
      const fromEmail = emailMatch ? emailMatch[1] : fromRaw;
      return {
        account: "gmail" as const,
        messageId: id,
        from: fromRaw,
        fromEmail,
        subject: h("Subject") || "(no subject)",
        receivedAt: new Date(parseInt(m.internalDate)).toISOString(),
        bodyPreview: (m.snippet || "").slice(0, 1000),
      };
    })
  );
  return details.filter(Boolean) as IncomingMsg[];
}

// ============================================================
// CLAUDE CLASSIFIER + DRAFTER
// ============================================================

// Two-stage pipeline. Haiku classifies every message (cheap, fast).
// Opus drafts replies ONLY for respond_today and respond_this_week.
// Running 72x/day with 50 msgs each on Opus was burning ~$20-30/day.
// Haiku is roughly 10x cheaper and more than accurate enough for 6-bucket sorting.

const CLASSIFIER_SYSTEM = `You are SAM, Dr. David Hatami's email triage agent. David is an AI Ethics consultant and higher education executive. He has active consulting clients, teaches at Post University, and runs EduPolicy.ai. His inbox gets 50-100 messages a day, most worthless.

Classify each email into ONE bucket and explain in ONE short sentence:

- respond_today: From a real human (client, colleague, investor, institutional contact) who needs a reply today. Time-sensitive or relationship-critical.
- respond_this_week: Real person, professional context, but no rush. Reply within 5 business days.
- fyi: Worth reading but no action needed. Updates, announcements.
- newsletter: Recurring marketing, industry updates, subscriptions.
- spam: Cold sales, phishing, obvious junk, unsolicited offers.
- invoice_receipt: Transactional — invoices, receipts, shipping, account notifications.

Return ONLY valid JSON. No markdown fences, no preamble. Schema:
{"bucket":"<bucket>","reasoning":"<one sentence>"}`;

const DRAFTER_SYSTEM = `You are SAM, drafting a reply in Dr. David Hatami's voice. He's an AI Ethics consultant and higher ed executive. He'll edit before sending.

Rules:
- Short. 2-4 sentences maximum.
- No corporate wallpaper. No "I hope this finds you well." No "Per my last email."
- Banned words: leverage, utilize, facilitate, robust, synergy, bandwidth, deep dive, circle back, low-hanging fruit, ecosystem, landscape, navigate, comprehensive.
- Contractions always: don't, can't, I'll.
- Direct and warm. Signs off "— David" or "— D" depending on familiarity.
- New contact (no prior relationship apparent): use "— David Hatami".
- If you don't have enough context to draft confidently, return exactly: NO_DRAFT

Return ONLY the reply text or the literal string NO_DRAFT. No preamble, no JSON.`;

async function classifyOne(msg: IncomingMsg): Promise<{
  bucket: TriageBucket;
  reasoning: string;
  draftReply: string | null;
}> {
  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing");

  const userPrompt = `From: ${msg.from}
Subject: ${msg.subject}
Received: ${msg.receivedAt}
Account: ${msg.account}

Body preview:
${msg.bodyPreview}`;

  // STAGE 1 — Haiku classifier (cheap)
  const classifyResp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 200,
      system: CLASSIFIER_SYSTEM,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!classifyResp.ok) {
    const err = await classifyResp.text();
    throw new Error(`Claude classify failed: ${classifyResp.status} ${err}`);
  }
  const classifyData = await classifyResp.json();
  try {
    const { trackCost } = await import("./llm-cost.ts");
    await trackCost({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      feature: "triage_classify",
      responseBody: classifyData,
    });
  } catch {}
  const classifyText = classifyData.content?.[0]?.text || "{}";
  const clean = classifyText.replace(/```json|```/g, "").trim();

  let bucket: TriageBucket = "fyi";
  let reasoning = "no reasoning given";
  try {
    const parsed = JSON.parse(clean);
    if ((TRIAGE_BUCKETS as readonly string[]).includes(parsed.bucket)) {
      bucket = parsed.bucket as TriageBucket;
    }
    reasoning = parsed.reasoning || reasoning;
  } catch {}

  // STAGE 2 — Opus drafter (only for actionable buckets)
  let draftReply: string | null = null;
  if (bucket === "respond_today" || bucket === "respond_this_week") {
    try {
      const draftResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-opus-4-5",
          max_tokens: 500,
          system: DRAFTER_SYSTEM,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });
      if (draftResp.ok) {
        const draftData = await draftResp.json();
        try {
          const { trackCost } = await import("./llm-cost.ts");
          await trackCost({
            provider: "anthropic",
            model: "claude-opus-4-5",
            feature: "triage_draft",
            responseBody: draftData,
          });
        } catch {}
        const txt = (draftData.content?.[0]?.text || "").trim();
        draftReply = txt === "NO_DRAFT" || !txt ? null : txt;
      }
    } catch {
      // Draft failure is non-fatal — classification still stands
    }
  }

  return { bucket, reasoning, draftReply };
}

// ============================================================
// MAIN — pull new messages, triage each, store results
// ============================================================

export async function runTriage(force: boolean = false): Promise<{
  ok: true;
  processed: number;
  byBucket: Record<TriageBucket, number>;
  durationMs: number;
}> {
  const start = Date.now();
  const store = getStore({ name: "sam-triage", consistency: "strong" });

  // Load cursors — last processed time per account
  const defaultSince = new Date(Date.now() - 2 * 3600 * 1000).toISOString(); // 2h back on cold start
  const m365Cursor =
    (force ? null : ((await store.get("_cursor:m365", { type: "text" })) as string | null)) || defaultSince;
  const gmailCursor =
    (force ? null : ((await store.get("_cursor:gmail", { type: "text" })) as string | null)) || defaultSince;

  // Fetch new messages in parallel
  const [m365Msgs, gmailMsgs] = await Promise.all([
    fetchM365Since(m365Cursor).catch(() => []),
    fetchGmailSince(gmailCursor).catch(() => []),
  ]);

  const all: IncomingMsg[] = [...m365Msgs, ...gmailMsgs];
  if (!all.length) {
    return {
      ok: true,
      processed: 0,
      byBucket: emptyBucketCounts(),
      durationMs: Date.now() - start,
    };
  }

  // Classify in parallel with a concurrency cap to avoid rate limiting
  const CONCURRENCY = 5;
  const results: TriageResult[] = [];
  for (let i = 0; i < all.length; i += CONCURRENCY) {
    const batch = all.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (msg): Promise<TriageResult | null> => {
        const key = `${msg.account}:${msg.messageId}`;
        // Skip if already triaged (idempotent)
        const existing = await store.get(key, { type: "json" }).catch(() => null);
        if (existing && !force) return null;

        try {
          const { bucket, reasoning, draftReply } = await classifyOne(msg);
          const result: TriageResult = {
            id: key,
            account: msg.account,
            messageId: msg.messageId,
            from: msg.from,
            fromEmail: msg.fromEmail,
            subject: msg.subject,
            receivedAt: msg.receivedAt,
            bodyPreview: msg.bodyPreview.slice(0, 300),
            bucket,
            reasoning,
            draftReply,
            status: "pending",
            triagedAt: new Date().toISOString(),
          };
          await store.setJSON(key, result);
          return result;
        } catch (e: any) {
          console.error(`Triage failed for ${key}:`, e.message);
          return null;
        }
      })
    );
    results.push(...(batchResults.filter(Boolean) as TriageResult[]));
  }

  // Advance cursors to newest receivedAt per account
  const newestM365 = m365Msgs[0]?.receivedAt;
  const newestGmail = gmailMsgs[0]?.receivedAt;
  if (newestM365) await store.set("_cursor:m365", newestM365);
  if (newestGmail) await store.set("_cursor:gmail", newestGmail);

  // Bucket counts
  const byBucket = emptyBucketCounts();
  for (const r of results) byBucket[r.bucket]++;

  return {
    ok: true,
    processed: results.length,
    byBucket,
    durationMs: Date.now() - start,
  };
}

function emptyBucketCounts(): Record<TriageBucket, number> {
  return {
    respond_today: 0,
    respond_this_week: 0,
    fyi: 0,
    newsletter: 0,
    spam: 0,
    invoice_receipt: 0,
  };
}

// ============================================================
// QUEUE ACCESSORS — used by HTTP endpoint
// ============================================================

export async function listPendingTriage(): Promise<TriageResult[]> {
  const store = getStore({ name: "sam-triage", consistency: "strong" });
  const { blobs } = await store.list();
  const triageBlobs = blobs.filter((b: any) => !b.key.startsWith("_cursor:"));
  const all = await Promise.all(
    triageBlobs.map((b: any) => store.get(b.key, { type: "json" }).catch(() => null))
  );
  return (all.filter(Boolean) as TriageResult[])
    .filter((t) => t.status === "pending")
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

export async function updateTriageStatus(
  id: string,
  status: TriageResult["status"],
  editedReply?: string
): Promise<boolean> {
  const store = getStore({ name: "sam-triage", consistency: "strong" });
  const item = (await store.get(id, { type: "json" })) as TriageResult | null;
  if (!item) return false;
  item.status = status;
  if (editedReply !== undefined) item.draftReply = editedReply;
  await store.setJSON(id, item);
  return true;
}
