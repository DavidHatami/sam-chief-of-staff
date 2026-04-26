import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

/**
 * SAM OAUTH SERVER — single-user OAuth 2.1 + PKCE + Dynamic Client Registration
 *
 * This file handles every OAuth route Claude.ai needs to connect a custom MCP
 * connector. It implements the minimum viable OAuth dance per:
 *   - RFC 7591 (Dynamic Client Registration)
 *   - RFC 8414 (Authorization Server Metadata)
 *   - RFC 9728 (Protected Resource Metadata, MCP-spec requirement)
 *   - OAuth 2.1 with PKCE (S256)
 *
 * Routes (all behind one function via config.path):
 *   GET  /.well-known/oauth-protected-resource
 *        → Tells the client which auth server to talk to.
 *   GET  /.well-known/oauth-authorization-server
 *        → Tells the client where the register/authorize/token endpoints live.
 *   POST /api/oauth/register
 *        → Dynamic Client Registration. Claude.ai POSTs its metadata, we
 *          mint a client_id (and optional client_secret) and return them.
 *   GET  /api/oauth/authorize
 *        → Renders an HTML consent page. David enters his owner password
 *          (the existing SAM_MCP_SECRET env var). On approve we generate
 *          an auth code bound to the PKCE challenge and 302 redirect back
 *          to Claude.ai's redirect_uri with code + state.
 *   POST /api/oauth/token
 *        → Code-for-token exchange with PKCE verification. Issues a long-lived
 *          opaque access token (no refresh tokens needed for single-user).
 *
 * Storage: Netlify Blobs store "sam-oauth", keys:
 *   clients/<client_id>   → registered client metadata
 *   codes/<code>          → pending auth code (5-min TTL)
 *   tokens/<token>        → issued access token (90-day TTL)
 *
 * Single-user gate: the consent page requires SAM_MCP_SECRET as the password.
 * Only David has that. Random visitors who somehow find /api/oauth/authorize
 * cannot approve anything.
 */

const STORE_NAME = "sam-oauth";
const CODE_TTL_SEC = 300;        // 5 min — auth codes are short-lived
const TOKEN_TTL_SEC = 90 * 24 * 3600; // 90 days

interface RegisteredClient {
  client_id: string;
  client_secret?: string;        // optional, only for confidential clients
  client_id_issued_at: number;
  redirect_uris: string[];
  client_name?: string;
  token_endpoint_auth_method: "none" | "client_secret_post" | "client_secret_basic";
  grant_types: string[];
  response_types: string[];
}

interface PendingAuthCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: "S256" | "plain";
  scope?: string;
  expires_at: number;
}

interface IssuedToken {
  access_token: string;
  client_id: string;
  scope?: string;
  expires_at: number;
}

function getOrigin(req: Request): string {
  const u = new URL(req.url);
  return `${u.protocol}//${u.host}`;
}

function rand(bytes: number): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function sha256b64url(input: string): string {
  return crypto.createHash("sha256").update(input).digest("base64url");
}

function jsonResp(body: any, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// /.well-known/oauth-protected-resource
// ─────────────────────────────────────────────────────────────────────────
function handleProtectedResourceMetadata(req: Request): Response {
  const origin = getOrigin(req);
  return jsonResp({
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    resource_documentation: `${origin}/`,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// /.well-known/oauth-authorization-server
// ─────────────────────────────────────────────────────────────────────────
function handleAuthServerMetadata(req: Request): Response {
  const origin = getOrigin(req);
  return jsonResp({
    issuer: origin,
    authorization_endpoint: `${origin}/api/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: ["mcp"],
  });
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/oauth/register — Dynamic Client Registration (RFC 7591)
// ─────────────────────────────────────────────────────────────────────────
async function handleRegister(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResp({ error: "invalid_request", error_description: "body must be JSON" }, 400);
  }
  const redirect_uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris : [];
  if (redirect_uris.length === 0) {
    return jsonResp({ error: "invalid_redirect_uri", error_description: "at least one redirect_uri is required" }, 400);
  }
  const grant_types = Array.isArray(body?.grant_types) ? body.grant_types : ["authorization_code"];
  const response_types = Array.isArray(body?.response_types) ? body.response_types : ["code"];
  const token_endpoint_auth_method = body?.token_endpoint_auth_method || "none";

  const client_id = rand(24);
  const issuesSecret = token_endpoint_auth_method !== "none";
  const client_secret = issuesSecret ? rand(32) : undefined;

  const reg: RegisteredClient = {
    client_id,
    ...(client_secret ? { client_secret } : {}),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris,
    client_name: body?.client_name,
    token_endpoint_auth_method,
    grant_types,
    response_types,
  };

  const store = getStore({ name: STORE_NAME, consistency: "strong" });
  await store.setJSON(`clients/${client_id}`, reg);

  return jsonResp(
    {
      ...reg,
      ...(client_secret ? { client_secret_expires_at: 0 } : {}),
    },
    201
  );
}

// ─────────────────────────────────────────────────────────────────────────
// GET /api/oauth/authorize — consent page + (on POST) approval handler
// ─────────────────────────────────────────────────────────────────────────
function consentPageHtml(args: {
  client_id: string;
  client_name?: string;
  redirect_uri: string;
  state?: string;
  code_challenge: string;
  code_challenge_method: string;
  scope?: string;
  error?: string;
}): string {
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>SAM — Approve connection</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; background: #0a0a0a; color: #eee; max-width: 480px; margin: 60px auto; padding: 0 20px; }
    h1 { margin-top: 0; font-size: 24px; }
    .card { background: #161616; border: 1px solid #2a2a2a; border-radius: 12px; padding: 28px; }
    .row { color: #aaa; font-size: 13px; margin: 8px 0; word-break: break-all; }
    .row b { color: #eee; font-weight: 500; }
    label { display: block; margin: 18px 0 6px; font-size: 13px; color: #aaa; }
    input[type=password] { width: 100%; padding: 10px 12px; background: #0a0a0a; border: 1px solid #333; border-radius: 8px; color: #eee; font-size: 14px; box-sizing: border-box; }
    button { width: 100%; padding: 12px; margin-top: 18px; background: #6c5ce7; color: #fff; border: 0; border-radius: 8px; font-size: 15px; font-weight: 500; cursor: pointer; }
    button:hover { background: #7d6cef; }
    .err { background: #3a1a1a; border: 1px solid #5a2a2a; color: #ff8888; padding: 10px 14px; border-radius: 8px; margin: 14px 0; font-size: 13px; }
    .small { color: #666; font-size: 12px; margin-top: 22px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Approve SAM access</h1>
    <p style="color:#aaa;font-size:14px;line-height:1.5;">
      <b style="color:#eee">${escape(args.client_name || args.client_id)}</b> is requesting access to your SAM data.
    </p>
    <div class="row"><b>Client:</b> ${escape(args.client_id)}</div>
    <div class="row"><b>Redirect:</b> ${escape(args.redirect_uri)}</div>
    <div class="row"><b>Scope:</b> ${escape(args.scope || "mcp")}</div>
    ${args.error ? `<div class="err">${escape(args.error)}</div>` : ""}
    <form method="POST" action="/api/oauth/authorize">
      <input type="hidden" name="client_id" value="${escape(args.client_id)}">
      <input type="hidden" name="redirect_uri" value="${escape(args.redirect_uri)}">
      <input type="hidden" name="state" value="${escape(args.state || "")}">
      <input type="hidden" name="code_challenge" value="${escape(args.code_challenge)}">
      <input type="hidden" name="code_challenge_method" value="${escape(args.code_challenge_method)}">
      <input type="hidden" name="scope" value="${escape(args.scope || "mcp")}">
      <label for="owner_password">Owner password</label>
      <input type="password" id="owner_password" name="owner_password" autofocus required>
      <button type="submit">Approve</button>
    </form>
    <div class="small">
      Only the owner of this SAM instance can approve a connection.<br>
      Password is the SAM_MCP_SECRET env var set in Netlify.
    </div>
  </div>
</body>
</html>`;
}

async function handleAuthorizeGet(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const params = url.searchParams;
  const client_id = params.get("client_id") || "";
  const redirect_uri = params.get("redirect_uri") || "";
  const response_type = params.get("response_type") || "";
  const state = params.get("state") || "";
  const code_challenge = params.get("code_challenge") || "";
  const code_challenge_method = params.get("code_challenge_method") || "S256";
  const scope = params.get("scope") || "mcp";

  if (!client_id || !redirect_uri || response_type !== "code" || !code_challenge) {
    return new Response(
      "Invalid authorize request. Required params: client_id, redirect_uri, response_type=code, code_challenge.",
      { status: 400, headers: { "content-type": "text/plain" } }
    );
  }
  if (code_challenge_method !== "S256") {
    return new Response("Only code_challenge_method=S256 is supported.", {
      status: 400,
      headers: { "content-type": "text/plain" },
    });
  }

  // Look up client. Must exist and the redirect_uri must be on its list.
  const store = getStore({ name: STORE_NAME, consistency: "strong" });
  const client = (await store.get(`clients/${client_id}`, { type: "json" })) as RegisteredClient | null;
  if (!client) {
    return new Response("Unknown client_id. Did you register first?", {
      status: 400,
      headers: { "content-type": "text/plain" },
    });
  }
  if (!client.redirect_uris.includes(redirect_uri)) {
    return new Response("redirect_uri does not match any registered redirect_uris for this client.", {
      status: 400,
      headers: { "content-type": "text/plain" },
    });
  }

  return new Response(
    consentPageHtml({
      client_id,
      client_name: client.client_name,
      redirect_uri,
      state,
      code_challenge,
      code_challenge_method,
      scope,
    }),
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

async function handleAuthorizePost(req: Request): Promise<Response> {
  const form = await req.formData();
  const client_id = String(form.get("client_id") || "");
  const redirect_uri = String(form.get("redirect_uri") || "");
  const state = String(form.get("state") || "");
  const code_challenge = String(form.get("code_challenge") || "");
  const code_challenge_method = String(form.get("code_challenge_method") || "S256");
  const scope = String(form.get("scope") || "mcp");
  const owner_password = String(form.get("owner_password") || "");

  const expected = Netlify.env.get("SAM_MCP_SECRET");
  if (!expected || owner_password !== expected) {
    // Re-render the consent page with an error. Safer than redirecting back
    // to the client with an error param — keeps the wrong-password attempt
    // in the owner's browser.
    const store = getStore({ name: STORE_NAME, consistency: "strong" });
    const client = (await store.get(`clients/${client_id}`, { type: "json" })) as RegisteredClient | null;
    return new Response(
      consentPageHtml({
        client_id,
        client_name: client?.client_name,
        redirect_uri,
        state,
        code_challenge,
        code_challenge_method,
        scope,
        error: "Wrong owner password.",
      }),
      { status: 401, headers: { "content-type": "text/html; charset=utf-8" } }
    );
  }

  // Verify client + redirect_uri again (defense in depth — hidden form fields
  // could have been tampered with in transit).
  const store = getStore({ name: STORE_NAME, consistency: "strong" });
  const client = (await store.get(`clients/${client_id}`, { type: "json" })) as RegisteredClient | null;
  if (!client || !client.redirect_uris.includes(redirect_uri)) {
    return new Response("Invalid client_id / redirect_uri.", {
      status: 400,
      headers: { "content-type": "text/plain" },
    });
  }

  const code = rand(32);
  const pending: PendingAuthCode = {
    code,
    client_id,
    redirect_uri,
    code_challenge,
    code_challenge_method: "S256",
    scope,
    expires_at: Math.floor(Date.now() / 1000) + CODE_TTL_SEC,
  };
  await store.setJSON(`codes/${code}`, pending);

  // 302 back to client with code + state
  const u = new URL(redirect_uri);
  u.searchParams.set("code", code);
  if (state) u.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: { location: u.toString(), "cache-control": "no-store" },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/oauth/token — code-for-token exchange with PKCE check
// ─────────────────────────────────────────────────────────────────────────
async function readTokenBody(req: Request): Promise<URLSearchParams> {
  // Accept both application/x-www-form-urlencoded and JSON.
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    const j = await req.json();
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(j || {})) p.set(k, String(v));
    return p;
  }
  const text = await req.text();
  return new URLSearchParams(text);
}

async function handleToken(req: Request): Promise<Response> {
  const params = await readTokenBody(req);
  const grant_type = params.get("grant_type") || "";
  if (grant_type !== "authorization_code") {
    return jsonResp({ error: "unsupported_grant_type" }, 400);
  }
  const code = params.get("code") || "";
  const redirect_uri = params.get("redirect_uri") || "";
  const client_id = params.get("client_id") || "";
  const code_verifier = params.get("code_verifier") || "";

  if (!code || !redirect_uri || !client_id || !code_verifier) {
    return jsonResp(
      { error: "invalid_request", error_description: "missing one of: code, redirect_uri, client_id, code_verifier" },
      400
    );
  }

  const store = getStore({ name: STORE_NAME, consistency: "strong" });
  const pending = (await store.get(`codes/${code}`, { type: "json" })) as PendingAuthCode | null;
  if (!pending) return jsonResp({ error: "invalid_grant", error_description: "code unknown or already used" }, 400);
  // Single-use: delete immediately so a replay can't reuse it.
  await store.delete(`codes/${code}`);

  if (pending.expires_at < Math.floor(Date.now() / 1000)) {
    return jsonResp({ error: "invalid_grant", error_description: "code expired" }, 400);
  }
  if (pending.client_id !== client_id) {
    return jsonResp({ error: "invalid_grant", error_description: "client_id mismatch" }, 400);
  }
  if (pending.redirect_uri !== redirect_uri) {
    return jsonResp({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
  }

  // PKCE verification
  if (pending.code_challenge_method === "S256") {
    if (sha256b64url(code_verifier) !== pending.code_challenge) {
      return jsonResp({ error: "invalid_grant", error_description: "PKCE verifier failed" }, 400);
    }
  } else {
    if (code_verifier !== pending.code_challenge) {
      return jsonResp({ error: "invalid_grant", error_description: "PKCE verifier failed" }, 400);
    }
  }

  // Mint token.
  const access_token = rand(48);
  const issued: IssuedToken = {
    access_token,
    client_id,
    scope: pending.scope,
    expires_at: Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC,
  };
  await store.setJSON(`tokens/${access_token}`, issued);

  return jsonResp({
    access_token,
    token_type: "Bearer",
    expires_in: TOKEN_TTL_SEC,
    scope: pending.scope || "mcp",
  });
}

// ─────────────────────────────────────────────────────────────────────────
// PUBLIC API for mcp.mts to validate a bearer token
// ─────────────────────────────────────────────────────────────────────────
export async function isValidIssuedToken(token: string): Promise<boolean> {
  if (!token) return false;
  try {
    const store = getStore({ name: STORE_NAME, consistency: "strong" });
    const t = (await store.get(`tokens/${token}`, { type: "json" })) as IssuedToken | null;
    if (!t) return false;
    if (t.expires_at < Math.floor(Date.now() / 1000)) {
      await store.delete(`tokens/${token}`).catch(() => {});
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// ROUTER
// ─────────────────────────────────────────────────────────────────────────
export default async (req: Request, _context: Context) => {
  const url = new URL(req.url);
  const path = url.pathname;

  // CORS preflight (Claude.ai's browser-side flow doesn't typically need it,
  // but be permissive for discovery endpoints since they're public.)
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
      },
    });
  }

  if (path === "/.well-known/oauth-protected-resource" && req.method === "GET") {
    return handleProtectedResourceMetadata(req);
  }
  if (path === "/.well-known/oauth-authorization-server" && req.method === "GET") {
    return handleAuthServerMetadata(req);
  }
  if (path === "/api/oauth/register" && req.method === "POST") {
    return handleRegister(req);
  }
  if (path === "/api/oauth/authorize" && req.method === "GET") {
    return handleAuthorizeGet(req);
  }
  if (path === "/api/oauth/authorize" && req.method === "POST") {
    return handleAuthorizePost(req);
  }
  if (path === "/api/oauth/token" && req.method === "POST") {
    return handleToken(req);
  }

  return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
};

export const config: Config = {
  path: [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server",
    "/api/oauth/register",
    "/api/oauth/authorize",
    "/api/oauth/token",
  ],
};
