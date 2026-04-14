import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

/**
 * Email Flags/Pins for SAM — Unified across all accounts
 *
 * GET    /api/flags              → Get all flagged email IDs
 * POST   /api/flags              → Flag/pin an email
 * DELETE /api/flags?id=X&acct=Y  → Unflag/unpin an email
 *
 * Stores in Netlify Blobs: { flags: [ { id, account, subject, from, flaggedAt, color } ] }
 *
 * Also syncs with native APIs when possible:
 *   - M365: Sets/clears flag via Graph API
 *   - Gmail: Stars/unstars via Gmail API
 *   - Yahoo: Local only (no API for flags)
 */

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

interface EmailFlag {
  id: string;
  account: string; // 'm365' | 'gmail' | 'yahoo'
  subject: string;
  from: string;
  flaggedAt: string;
  color: string; // 'red' | 'amber' | 'blue' | 'green' | 'default'
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const headers = { "Content-Type": "application/json" };
  const store = getStore({ name: "email-flags", consistency: "strong" });

  try {
    // ── GET ALL FLAGS ──
    if (req.method === "GET") {
      const data = await store.get("flags", { type: "json" });
      const flags: EmailFlag[] = data || [];
      return new Response(JSON.stringify({ flags }), { headers });
    }

    // ── FLAG/PIN AN EMAIL ──
    if (req.method === "POST") {
      const body = await req.json();
      const { id, account, subject, from, color } = body;

      if (!id || !account) {
        return new Response(
          JSON.stringify({ error: "Missing id or account" }),
          { status: 400, headers }
        );
      }

      const data = await store.get("flags", { type: "json" });
      const flags: EmailFlag[] = data || [];

      // Check if already flagged
      const existing = flags.find(
        (f) => f.id === id && f.account === account
      );
      if (existing) {
        // Update color
        existing.color = color || "default";
        await store.setJSON("flags", flags);
        return new Response(
          JSON.stringify({ success: true, message: "Flag updated" }),
          { headers }
        );
      }

      // Add new flag
      flags.push({
        id,
        account,
        subject: subject || "",
        from: from || "",
        flaggedAt: new Date().toISOString(),
        color: color || "default",
      });
      await store.setJSON("flags", flags);

      // Sync with native API
      if (account === "m365") {
        try {
          const token = await getM365Token();
          if (token) {
            const userEmail = Netlify.env.get("M365_USER_EMAIL") || "";
            await fetch(
              `https://graph.microsoft.com/v1.0/users/${userEmail}/messages/${id}`,
              {
                method: "PATCH",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  flag: { flagStatus: "flagged" },
                }),
              }
            );
          }
        } catch (e) {}
      } else if (account === "gmail") {
        try {
          const token = await getGmailToken();
          if (token) {
            await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/modify`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  addLabelIds: ["STARRED"],
                }),
              }
            );
          }
        } catch (e) {}
      }

      return new Response(
        JSON.stringify({ success: true, message: "Email flagged" }),
        { headers }
      );
    }

    // ── UNFLAG/UNPIN ──
    if (req.method === "DELETE") {
      const id = url.searchParams.get("id");
      const account = url.searchParams.get("acct");

      if (!id || !account) {
        return new Response(
          JSON.stringify({ error: "Missing id or acct param" }),
          { status: 400, headers }
        );
      }

      const data = await store.get("flags", { type: "json" });
      let flags: EmailFlag[] = data || [];
      flags = flags.filter(
        (f) => !(f.id === id && f.account === account)
      );
      await store.setJSON("flags", flags);

      // Sync with native API
      if (account === "m365") {
        try {
          const token = await getM365Token();
          if (token) {
            const userEmail = Netlify.env.get("M365_USER_EMAIL") || "";
            await fetch(
              `https://graph.microsoft.com/v1.0/users/${userEmail}/messages/${id}`,
              {
                method: "PATCH",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  flag: { flagStatus: "notFlagged" },
                }),
              }
            );
          }
        } catch (e) {}
      } else if (account === "gmail") {
        try {
          const token = await getGmailToken();
          if (token) {
            await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/modify`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  removeLabelIds: ["STARRED"],
                }),
              }
            );
          }
        } catch (e) {}
      }

      return new Response(
        JSON.stringify({ success: true, message: "Email unflagged" }),
        { headers }
      );
    }

    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers,
    });
  }
};

export const config: Config = {
  path: ["/api/flags", "/api/flags/*"],
};
