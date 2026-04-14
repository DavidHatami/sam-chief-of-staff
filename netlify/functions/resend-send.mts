import type { Context, Config } from "@netlify/functions";

/**
 * Resend General Email Send for SAM
 *
 * POST /api/resend-send → Send email via Resend from any @edupolicy.ai address
 *
 * Body: { to: string[], subject: string, content: string, from: string, fromName?: string }
 *
 * Uses Resend API — domain must be verified in Resend dashboard.
 * Supports: dhatami@edupolicy.ai, admin@edupolicy.ai, booking@edupolicy.ai, or any @edupolicy.ai
 */

export default async (req: Request, context: Context) => {
  const headers = { "Content-Type": "application/json" };

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "POST required" }),
      { status: 405, headers }
    );
  }

  const RESEND_KEY = Netlify.env.get("RESEND_API_KEY");
  if (!RESEND_KEY) {
    return new Response(
      JSON.stringify({ error: "Resend API key not configured" }),
      { status: 500, headers }
    );
  }

  try {
    const body = await req.json();
    const { to, subject, content, from, fromName } = body;

    if (!to || !subject || !content) {
      return new Response(
        JSON.stringify({ error: "Missing to, subject, or content" }),
        { status: 400, headers }
      );
    }

    const toList = Array.isArray(to) ? to : [to];
    const fromAddr = from || "admin@edupolicy.ai";
    const name = fromName || "Dr. David Hatami";

    // Validate from address is on edupolicy.ai domain
    if (!fromAddr.endsWith("@edupolicy.ai")) {
      return new Response(
        JSON.stringify({ error: "Can only send from @edupolicy.ai addresses via Resend" }),
        { status: 400, headers }
      );
    }

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${name} <${fromAddr}>`,
        to: toList,
        subject: subject,
        text: content,
        reply_to: fromAddr,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      return new Response(
        JSON.stringify({ error: `Resend error: ${err}` }),
        { status: resp.status, headers }
      );
    }

    const data = await resp.json();

    return new Response(
      JSON.stringify({
        success: true,
        message: `Email sent from ${fromAddr}`,
        emailId: data.id,
      }),
      { headers }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers }
    );
  }
};

export const config: Config = {
  path: "/api/resend-send",
};
