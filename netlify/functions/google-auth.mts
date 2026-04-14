import type { Context, Config } from "@netlify/functions";

/**
 * Google OAuth Callback Handler
 * 
 * Handles the OAuth2 redirect from Google and exchanges
 * the authorization code for tokens.
 * 
 * Flow:
 * 1. User visits /api/google-auth → redirects to Google consent
 * 2. Google redirects back with ?code=xxx
 * 3. This function exchanges code for refresh_token
 * 4. Displays the refresh token for the user to save
 *
 * REQUIRED ENV VARS:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 */

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const clientId = Netlify.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Netlify.env.get("GOOGLE_CLIENT_SECRET");
  const redirectUri = url.origin + "/api/google-auth";

  // Step 1: No code = redirect to Google consent screen
  if (!code) {
    if (!clientId) {
      return new Response(
        "<html><body style='font-family:sans-serif;padding:40px;background:#0a0b0d;color:#e8eaf0;'>" +
        "<h2>Google OAuth Setup</h2>" +
        "<p>GOOGLE_CLIENT_ID is not set in Netlify env vars.</p>" +
        "<p>Go to <a href='https://console.cloud.google.com/apis/credentials' style='color:#4a7cff;'>Google Cloud Console</a> → Create OAuth 2.0 Client ID → Set redirect URI to:<br><code style='background:#1a1d26;padding:4px 8px;border-radius:4px;'>" + redirectUri + "</code></p>" +
        "<p>Then set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Netlify env vars.</p>" +
        "</body></html>",
        { headers: { "Content-Type": "text/html" } }
      );
    }

    const scopes = [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.modify",
    ].join(" ");

    const authUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?" +
      new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: scopes,
        access_type: "offline",
        prompt: "consent",
        login_hint: "dh30111@gmail.com",
      }).toString();

    return Response.redirect(authUrl, 302);
  }

  // Step 2: Exchange code for tokens
  if (!clientId || !clientSecret) {
    return new Response("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET", { status: 500 });
  }

  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });

  const tokenData = await tokenResp.json();

  if (tokenData.error) {
    return new Response(
      "<html><body style='font-family:sans-serif;padding:40px;background:#0a0b0d;color:#e8eaf0;'>" +
      "<h2 style='color:#f87171;'>OAuth Error</h2>" +
      "<pre style='background:#1a1d26;padding:16px;border-radius:8px;overflow:auto;'>" +
      JSON.stringify(tokenData, null, 2) +
      "</pre></body></html>",
      { headers: { "Content-Type": "text/html" } }
    );
  }

  const refreshToken = tokenData.refresh_token || "No refresh token returned (try revoking access at myaccount.google.com/permissions and retry)";

  return new Response(
    `<html><body style='font-family:sans-serif;padding:40px;background:#0a0b0d;color:#e8eaf0;max-width:700px;'>
    <h2 style='color:#34d399;'>✅ Gmail OAuth Complete</h2>
    <p>Your Gmail refresh token has been generated. Copy it and close this tab.</p>
    <div style='background:#1a1d26;padding:16px;border-radius:8px;margin:16px 0;'>
      <label style='font-size:12px;color:#8b8fa3;'>Refresh Token (copy this):</label>
      <input type='text' value='${refreshToken}' readonly onclick='this.select()' style='width:100%;padding:10px;margin-top:6px;background:#0a0b0d;border:1px solid #2a2e3a;border-radius:6px;color:#e8eaf0;font-family:monospace;font-size:13px;'>
    </div>
    <p style='color:#8b8fa3;font-size:13px;'>Paste this token back in the Claude chat so SAM can store it in Netlify. Then Gmail will be live in your dashboard.</p>
    </body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
};

export const config: Config = {
  path: "/api/google-auth",
};
