import type { Context, Config } from "@netlify/functions";
import { serve } from "inngest/lambda";
import { inngest, functions } from "../lib/inngest-functions.ts";

/**
 * SAM ↔ INNGEST WEBHOOK RECEIVER — Phase 7
 *
 * This endpoint is what David pastes into the Inngest dashboard's "Sync
 * new app" prompt: https://sam-chief-of-staff.netlify.app/api/inngest
 *
 * Inngest hits this URL to:
 *   1. Discover function definitions (PUT request, returns the registry)
 *   2. Invoke a step (POST request with signature header)
 *
 * The signing key is REQUIRED in production. Without it, Inngest's POST
 * webhooks fail signature verification and no functions ever execute.
 * If INNGEST_SIGNING_KEY is missing, the handler still serves discovery
 * (PUT) so the Inngest dashboard can register the app, but invocations
 * will all fail with a clear error message.
 *
 * Why inngest/lambda instead of inngest/edge: Netlify Functions v2 use
 * the Web Fetch API but their underlying compute is AWS Lambda. The
 * inngest/lambda adapter knows how to translate between the two.
 */

// inngest/lambda's serve returns a handler with (event, context) signature.
// We adapt it to Netlify Functions v2's (Request, Context) by translating
// the request and re-emitting the response.
const lambdaHandler = serve({
  client: inngest,
  functions,
});

async function requestToLambdaEvent(req: Request): Promise<any> {
  const url = new URL(req.url);
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k] = v; });
  const body = req.method !== "GET" && req.method !== "HEAD" ? await req.text() : null;
  return {
    httpMethod: req.method,
    path: url.pathname,
    headers,
    queryStringParameters: Object.fromEntries(url.searchParams.entries()),
    body,
    isBase64Encoded: false,
    requestContext: { http: { method: req.method, path: url.pathname } },
  };
}

function lambdaResponseToResponse(lambdaResp: any): Response {
  const headers = new Headers();
  if (lambdaResp.headers) {
    for (const [k, v] of Object.entries(lambdaResp.headers)) {
      headers.set(k, String(v));
    }
  }
  return new Response(lambdaResp.body || null, {
    status: lambdaResp.statusCode || 200,
    headers,
  });
}

export default async (req: Request, _ctx: Context) => {
  try {
    const event = await requestToLambdaEvent(req);
    const lambdaResp: any = await (lambdaHandler as any)(event, {});
    return lambdaResponseToResponse(lambdaResp);
  } catch (e: any) {
    console.error("[inngest-serve] failed:", e?.message || e);
    return new Response(JSON.stringify({ error: e?.message || String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const config: Config = {
  path: "/api/inngest",
};
