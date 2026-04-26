import type { Context, Config } from "@netlify/functions";
import { SAM_TOOLS, executeTool, type ToolContext } from "../lib/sam-tools.ts";

/**
 * SAM MCP SERVER — Model Context Protocol bridge to Claude.ai
 *
 * This endpoint speaks the MCP streamable-HTTP transport (JSON-RPC 2.0).
 * Once registered as a Connector in Claude.ai, every chat with Claude
 * gets direct access to SAM's tool surface — read tasks, create tasks,
 * check cron health, search chat history, send emails, etc. — without
 * David copy-pasting curl output.
 *
 * Registration steps for David (one-time, ~60 seconds):
 *   1. In Netlify env vars, set SAM_MCP_SECRET = <a long random string>
 *   2. In Claude.ai → Settings → Connectors → Add custom connector
 *   3. URL:  https://sam-chief-of-staff.netlify.app/api/mcp
 *      Auth: Bearer token, value = the SAM_MCP_SECRET you just set
 *   4. Save. Claude.ai introspects and shows the tool list.
 *
 * Methods implemented:
 *   - initialize        → handshake, returns protocol version + server info
 *   - tools/list        → returns the SAM tool surface as MCP tool definitions
 *   - tools/call        → runs a SAM tool, returns content blocks
 *   - notifications/initialized → no-op ack
 *   - ping              → health check
 *
 * Security model: a shared bearer token. The token MUST match the
 * SAM_MCP_SECRET env var or every request is rejected with HTTP 401.
 * No fallback. If the env var isn't set, the endpoint refuses everything.
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

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type, mcp-session-id",
      "access-control-allow-methods": "POST, OPTIONS",
    },
  });
}

function checkAuth(req: Request): { ok: boolean; reason?: string } {
  const expected = Netlify.env.get("SAM_MCP_SECRET");
  if (!expected) return { ok: false, reason: "server has no SAM_MCP_SECRET configured" };
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, reason: "missing Authorization: Bearer token" };
  if (m[1] !== expected) return { ok: false, reason: "token mismatch" };
  return { ok: true };
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

  const auth = checkAuth(req);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: "unauthorized", reason: auth.reason }), {
      status: 401,
      headers: { "content-type": "application/json", "www-authenticate": "Bearer" },
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
