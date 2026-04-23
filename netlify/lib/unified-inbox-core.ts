import { getStore } from "@netlify/blobs";

/**
 * SAM PHASE 2.1 — UNIFIED INBOX (shared core)
 *
 * Pulls current inbox from M365 + Gmail + Yahoo in parallel, normalizes
 * each provider's schema into a single envelope shape, then sorts by
 * urgency derived from the sam-triage blob store (populated by Phase 1.2).
 *
 * Urgency order (high → low):
 *   respond_today  →  respond_this_week  →  fyi  →  invoice_receipt  →  newsletter  →  spam  →  unclassified
 *
 * Within the same bucket, newer messages come first. Unclassified messages
 * (too recent for the every-20-min triage cron to have seen yet) fall
 * between fyi and newsletter — better to surface unknowns than bury them.
 *
 * Returned envelope shape is provider-agnostic so the UI can render one
 * list instead of three tabs.
 */

export const TZ = "America/New_York";

export type Account = "m365" | "gmail" | "yahoo";

export interface UnifiedMessage {
  id: string;               // provider-native message id
  account: Account;         // which inbox it came from
  from: { name: string; address: string };
  subject: string;
  preview: string;          // body preview, max ~300 chars
  receivedAt: string;       // ISO string, UTC
  isRead: boolean;
  bucket: string;           // triage bucket OR "unclassified"
  bucketReasoning: string | null;
  draftReply: string | null;
  urgencyRank: number;      // 0 (most urgent) ... 6 (least)
}

const BUCKET_RANK: Record<string, number> = {
  respond_today: 0,
  respond_this_week: 1,
  fyi: 2,
  unclassified: 3,
  invoice_receipt: 4,
  newsletter: 5,
  spam: 6,
};

// ============================================================
// PROVIDER FETCHERS — normalize into UnifiedMessage
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

async function fetchM365(limit: number): Promise<UnifiedMessage[]> {
  try {
    const token = await getM365Token();
    if (!token) return [];
    const userEmail = Netlify.env.get("M365_USER_EMAIL") || "";
    const url =
      `https://graph.microsoft.com/v1.0/users/${userEmail}/messages` +
      `?$select=id,subject,from,receivedDateTime,bodyPreview,isRead` +
      `&$orderby=receivedDateTime desc&$top=${limit}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.value || []).map((m: any): UnifiedMessage => ({
      id: m.id,
      account: "m365",
      from: {
        name: m.from?.emailAddress?.name || m.from?.emailAddress?.address || "unknown",
        address: m.from?.emailAddress?.address || "",
      },
      subject: m.subject || "(no subject)",
      preview: (m.bodyPreview || "").slice(0, 300).replace(/\s+/g, " "),
      receivedAt: m.receivedDateTime,
      isRead: !!m.isRead,
      bucket: "unclassified",
      bucketReasoning: null,
      draftReply: null,
      urgencyRank: BUCKET_RANK.unclassified,
    }));
  } catch {
    return [];
  }
}

async function fetchGmail(limit: number): Promise<UnifiedMessage[]> {
  try {
    const clientId = Netlify.env.get("GOOGLE_CLIENT_ID");
    const clientSecret = Netlify.env.get("GOOGLE_CLIENT_SECRET");
    const refreshToken = Netlify.env.get("G_REFRESH_TOKEN");
    if (!clientId || !clientSecret || !refreshToken) return [];

    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!tokenResp.ok) return [];
    const { access_token } = await tokenResp.json();

    const listResp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${limit}`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    if (!listResp.ok) return [];
    const list = await listResp.json();
    const ids: string[] = (list.messages || []).map((m: any) => m.id);
    if (!ids.length) return [];

    const details = await Promise.all(
      ids.map(async (id) => {
        const r = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${access_token}` } }
        );
        if (!r.ok) return null;
        const m = await r.json();
        const headers = m.payload?.headers || [];
        const h = (n: string) =>
          headers.find((x: any) => x.name === n)?.value || "";
        const rawFrom = h("From");
        // Parse "Name <email>" or bare email
        let fromName = rawFrom;
        let fromAddr = rawFrom;
        const match = rawFrom.match(/^(.*?)\s*<([^>]+)>$/);
        if (match) {
          fromName = match[1].replace(/^["']|["']$/g, "").trim() || match[2];
          fromAddr = match[2];
        }
        const dateStr = h("Date");
        const receivedAt = dateStr ? new Date(dateStr).toISOString() : new Date(parseInt(m.internalDate, 10)).toISOString();
        return {
          id,
          account: "gmail" as Account,
          from: { name: fromName, address: fromAddr },
          subject: h("Subject") || "(no subject)",
          preview: (m.snippet || "").slice(0, 300),
          receivedAt,
          isRead: !(m.labelIds || []).includes("UNREAD"),
          bucket: "unclassified",
          bucketReasoning: null,
          draftReply: null,
          urgencyRank: BUCKET_RANK.unclassified,
        };
      })
    );
    return details.filter(Boolean) as UnifiedMessage[];
  } catch {
    return [];
  }
}

async function fetchYahoo(_limit: number): Promise<UnifiedMessage[]> {
  // Yahoo uses IMAP + app password. The existing yahoo.mts function
  // handles that via a separate path. For the unified inbox we defer
  // to its stored cache rather than re-authing here, because IMAP
  // connections in serverless are expensive.
  try {
    const store = getStore({ name: "sam-yahoo-cache", consistency: "eventual" });
    const cached = await store.get("inbox", { type: "json" });
    if (!cached || !Array.isArray(cached.messages)) return [];
    return cached.messages.map((m: any): UnifiedMessage => ({
      id: m.uid || m.id,
      account: "yahoo",
      from: {
        name: m.fromName || m.from || "unknown",
        address: m.fromAddress || m.from || "",
      },
      subject: m.subject || "(no subject)",
      preview: (m.preview || m.text || "").slice(0, 300).replace(/\s+/g, " "),
      receivedAt: m.date || m.receivedAt || new Date().toISOString(),
      isRead: !!m.isRead,
      bucket: "unclassified",
      bucketReasoning: null,
      draftReply: null,
      urgencyRank: BUCKET_RANK.unclassified,
    }));
  } catch {
    return [];
  }
}

// ============================================================
// TRIAGE ENRICHMENT
// ============================================================

async function enrichWithTriage(messages: UnifiedMessage[]): Promise<UnifiedMessage[]> {
  try {
    const store = getStore({ name: "sam-triage", consistency: "eventual" });
    // Triage entries keyed by "{account}:{messageId}"
    const keys = messages.map((m) => `${m.account}:${m.id}`);
    const lookups = await Promise.all(
      keys.map(async (key) => {
        try {
          const v = await store.get(key, { type: "json" });
          return { key, data: v };
        } catch {
          return { key, data: null };
        }
      })
    );
    const byKey = new Map(lookups.map((l) => [l.key, l.data]));
    return messages.map((m) => {
      const key = `${m.account}:${m.id}`;
      const triage = byKey.get(key) as any;
      if (!triage) return m;
      const bucket = typeof triage.bucket === "string" ? triage.bucket : "unclassified";
      return {
        ...m,
        bucket,
        bucketReasoning: triage.reasoning || null,
        draftReply: triage.draftReply || null,
        urgencyRank: BUCKET_RANK[bucket] ?? BUCKET_RANK.unclassified,
      };
    });
  } catch {
    return messages;
  }
}

// ============================================================
// MAIN — the one function the HTTP wrapper calls
// ============================================================

export async function buildUnifiedInbox(opts: {
  perAccount?: number;
  filter?: string; // bucket filter: "actionable" | "respond_today" | etc.
}): Promise<{
  ok: true;
  messages: UnifiedMessage[];
  counts: Record<string, number>;
  perAccount: Record<Account, number>;
  durationMs: number;
}> {
  const start = Date.now();
  const perAccount = Math.max(5, Math.min(100, opts.perAccount ?? 40));

  const [m365, gmail, yahoo] = await Promise.all([
    fetchM365(perAccount),
    fetchGmail(perAccount),
    fetchYahoo(perAccount),
  ]);

  let all = [...m365, ...gmail, ...yahoo];
  all = await enrichWithTriage(all);

  // Sort: lowest urgencyRank first (most urgent), then newest first
  all.sort((a, b) => {
    if (a.urgencyRank !== b.urgencyRank) return a.urgencyRank - b.urgencyRank;
    return new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime();
  });

  // Filter if requested
  if (opts.filter === "actionable") {
    all = all.filter(
      (m) => m.bucket === "respond_today" || m.bucket === "respond_this_week"
    );
  } else if (opts.filter && opts.filter !== "all") {
    all = all.filter((m) => m.bucket === opts.filter);
  }

  // Build per-bucket counts (before filter was applied — use pre-filter set)
  const counts: Record<string, number> = {};
  const perAccountCounts: Record<Account, number> = { m365: m365.length, gmail: gmail.length, yahoo: yahoo.length };
  for (const m of [...m365, ...gmail, ...yahoo]) {
    counts[m.bucket] = (counts[m.bucket] || 0) + 1;
  }

  return {
    ok: true,
    messages: all,
    counts,
    perAccount: perAccountCounts,
    durationMs: Date.now() - start,
  };
}
