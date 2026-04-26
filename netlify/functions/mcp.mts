import type { Context, Config } from "@netlify/functions";
import { SAM_TOOLS, executeTool, type ToolContext } from "../lib/sam-tools.ts";
import { isValidIssuedToken } from "./oauth.mts";

/**
 * SAM MCP SERVER — Model Context Protocol bridge to Claude.ai
 *
 * Speaks streamable-HTTP JSON-RPC 2.0. Once registered as a Connector in
 * Claude.ai, every chat with Claude can read/write SAM data directly.
 *
 * Auth:
 *   1) OAuth bearer token issued by /api/oauth/token (preferred — Claude.ai
 *      uses this path). On 401, the WWW-Authenticate header points at the
 *      protected-resource metadata so Claude.ai can begin the OAuth flow.
 *   2) SAM_MCP_SECRET env var (legacy / direct calls — useful for curl tests
 *      and anything that bypasses the OAuth dance).
 *
 * Methods implemented:
 *   - initialize        → handshake, returns protocol version + server info
 *   - tools/list        → SAM_TOOLS surface translated to MCP tool defs
 *   - tools/call        → routes to executeTool() — same code path the
 *                         in-app Claude agent already uses
 *   - notifications/initialized → no-op ack (returns 202)
 *   - ping              → health check
 */

const PROTOCOL_VERSION = "2024-11-05";

type JsonRpcRequest = { jsonrpc: "2.0"; id?: number | string | null; method: string; params?: any };
type JsonRpcResponse = { jsonrpc: "2.0"; id: number | string | null; result?: any; error?: { code: number; message: string; data?: any } };

function rpcOk(id: number | string | null, result: any): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcErr(id: number | string | null, code: number, message: string, data?: any): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function jsonResponse(body: any, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type, mcp-session-id",
      "access-control-allow-methods": "POST, OPTIONS",
      ...extraHeaders,
    },
  });
}

async function checkAuth(req: Request): Promise<{ ok: boolean; reason?: string }> {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, reason: "missing Authorization: Bearer token" };
  const token = m[1].trim();

  // Path 1: OAuth-issued token (preferred — Claude.ai uses this).
  if (await isValidIssuedToken(token)) return { ok: true };

  // Path 2: legacy direct-access token via env var (curl, scripts).
  const envSecret = Netlify.env.get("SAM_MCP_SECRET");
  if (envSecret && token === envSecret) return { ok: true };

  return { ok: false, reason: "token not recognized" };
}

async function handleRpc(req: JsonRpcRequest, ctx: ToolContext): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  switch (req.method) {
    case "initialize":
      return rpcOk(id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: { name: "sam-chief-of-staff", version: "1.0.0" },
        capabilities: { tools: { listChanged: false } },
      });

    case "notifications/initialized":
      // Notifications get no response body. Return null so caller skips the response.
      return null;

    case "ping":
      return rpcOk(id, {});

    case "tools/list":
      return rpcOk(id, {
        tools: SAM_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.input_schema,
        })),
      });

    case "tools/call": {
      const params = req.params || {};
      const name: string = params.name;
      const args: any = params.arguments || {};
      if (!name) return rpcErr(id, -32602, "missing required param: name");
      const result = await executeTool(name, args, ctx);
      const isError = !!(result && result.error);
      return rpcOk(id, {
        content: [
          { type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) },
        ],
        isError,
      });
    }

    default:
      return rpcErr(id, -32601, `Method not found: ${req.method}`);
  }
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization, content-type, mcp-session-id",
        "access-control-allow-methods": "POST, OPTIONS",
      },
    });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "POST required" }, 405);
  }

  const auth = await checkAuth(req);
  if (!auth.ok) {
    const origin = `${new URL(req.url).protocol}//${new URL(req.url).host}`;
    const wwwAuth = `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`;
    return new Response(JSON.stringify({ error: "unauthorized", reason: auth.reason }), {
      status: 401,
      headers: { "content-type": "application/json", "www-authenticate": wwwAuth },
    });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(rpcErr(null, -32700, "Parse error: invalid JSON"), 400);
  }

  const reqUrl = new URL(req.url);
  const ctx: ToolContext = { siteOrigin: `${reqUrl.protocol}//${reqUrl.host}` };

  // Support batch requests per JSON-RPC spec.
  if (Array.isArray(body)) {
    const responses = await Promise.all(body.map((r) => handleRpc(r, ctx)));
    const filtered = responses.filter((r): r is JsonRpcResponse => r !== null);
    if (filtered.length === 0) return new Response(null, { status: 204 });
    return jsonResponse(filtered);
  }

  const response = await handleRpc(body, ctx);
  if (response === null) {
    // Notification — no body, 202 Accepted per spec.
    return new Response(null, {
      status: 202,
      headers: { "access-control-allow-origin": "*" },
    });
  }
  return jsonResponse(response);
};

export const config: Config = {
  path: ["/api/mcp"],
};
