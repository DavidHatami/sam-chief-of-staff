import type { Context, Config } from "@netlify/functions";

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const RESEND_KEY = Netlify.env.get("RESEND_API_KEY");
  if (!RESEND_KEY) {
    return new Response(
      JSON.stringify({ error: "Email service not configured" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const body = await req.json();
    const { email, startISO, endISO } = body;

    // HTML-escape all user-controlled display fields before interpolation so booking form
    // submissions can't smuggle HTML into admin's inbox. Email clients sanitize
    // aggressively but relying on that is wrong — escape at the source.
    // Note: `email` stays raw because it's used as an actual recipient address,
    // and we HTML-escape separately when it appears inside markup.
    const esc = (s: any) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const name = esc(body.name);
    const type = esc(body.type);
    const date = esc(body.date);
    const time = esc(body.time);
    const duration = esc(body.duration);
    const org = esc(body.org);
    const notes = esc(body.notes);
    const platform = esc(body.platform);
    const escEmail = esc(body.email);

    // ── EMAIL TO CLIENT ──
    const clientHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;">

<tr><td style="background:linear-gradient(135deg,#4a7cff,#7c3aed);padding:32px 40px;text-align:center;">
  <h1 style="color:#ffffff;font-size:22px;margin:0 0 4px;">Booking Confirmed</h1>
  <p style="color:rgba(255,255,255,0.85);font-size:14px;margin:0;">Your meeting with Dr. David Hatami is scheduled</p>
</td></tr>

<tr><td style="padding:32px 40px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fb;border-radius:8px;padding:20px;margin-bottom:24px;">
  <tr><td>
    <p style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Meeting Details</p>
    <p style="margin:0 0 8px;font-size:17px;font-weight:600;color:#111827;">${type}</p>
    <p style="margin:0 0 6px;font-size:15px;color:#374151;">${date}</p>
    <p style="margin:0 0 6px;font-size:15px;color:#374151;">${time}</p>
    <p style="margin:0;font-size:14px;color:#6b7280;">Duration: ${duration} minutes</p>
    <p style="margin:6px 0 0;font-size:14px;color:#6b7280;">Platform: ${platform || "Google Meet"}</p>
  </td></tr>
  </table>

  <p style="font-size:15px;color:#374151;line-height:1.6;margin:0 0 16px;">
    Hi ${name},
  </p>
  <p style="font-size:15px;color:#374151;line-height:1.6;margin:0 0 16px;">
    Your meeting has been confirmed. Dr. Hatami will send a calendar invitation with the meeting link to this email address shortly.
  </p>
  <p style="font-size:15px;color:#374151;line-height:1.6;margin:0 0 16px;">
    If you need to reschedule or cancel, please email <a href="mailto:admin@edupolicy.ai" style="color:#4a7cff;text-decoration:none;">admin@edupolicy.ai</a> or call 727-741-7748.
  </p>

  <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;padding-top:20px;margin-top:24px;">
  <tr><td>
    <p style="margin:0 0 4px;font-size:14px;font-weight:600;color:#111827;">Dr. David Hatami, Ed.D.</p>
    <p style="margin:0 0 2px;font-size:13px;color:#6b7280;">AI Ethics & Policy Consultant</p>
    <p style="margin:0 0 2px;font-size:13px;color:#6b7280;">Managing Director, EduPolicy.ai</p>
    <p style="margin:0;font-size:13px;color:#6b7280;">admin@edupolicy.ai | 727-741-7748</p>
  </td></tr>
  </table>
</td></tr>

<tr><td style="background:#f8f9fb;padding:16px 40px;text-align:center;">
  <p style="margin:0;font-size:12px;color:#9ca3af;">Powered by SAM — Chief of Staff | EduPolicy.ai</p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

    // ── EMAIL TO DR. HATAMI ──
    const adminHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;">

<tr><td style="background:#111827;padding:24px 40px;">
  <h1 style="color:#ffffff;font-size:18px;margin:0;">SAM — New Booking</h1>
</td></tr>

<tr><td style="padding:28px 40px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4ff;border-radius:8px;padding:20px;margin-bottom:20px;border-left:4px solid #4a7cff;">
  <tr><td>
    <p style="margin:0 0 8px;font-size:16px;font-weight:600;color:#111827;">${type}</p>
    <p style="margin:0 0 4px;font-size:14px;color:#374151;">${date} at ${time}</p>
    <p style="margin:0;font-size:14px;color:#6b7280;">Duration: ${duration} min | Platform: ${platform || "Google Meet"}</p>
  </td></tr>
  </table>

  <table width="100%" cellpadding="4" cellspacing="0" style="font-size:14px;color:#374151;">
  <tr><td style="font-weight:600;width:100px;vertical-align:top;">Name:</td><td>${name}</td></tr>
  <tr><td style="font-weight:600;vertical-align:top;">Email:</td><td><a href="mailto:${escEmail}" style="color:#4a7cff;">${escEmail}</a></td></tr>
  ${org ? `<tr><td style="font-weight:600;vertical-align:top;">Org:</td><td>${org}</td></tr>` : ""}
  ${notes ? `<tr><td style="font-weight:600;vertical-align:top;">Notes:</td><td>${notes}</td></tr>` : ""}
  </table>

  ${startISO ? `<p style="margin:20px 0 0;font-size:13px;color:#6b7280;">Start: ${startISO}<br>End: ${endISO}</p>` : ""}
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

    // Send both emails via Resend
    const [clientResp, adminResp] = await Promise.all([
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Dr. David Hatami <booking@edupolicy.ai>",
          to: [email],
          subject: `Booking Confirmed: ${type} — ${date}`,
          html: clientHtml,
          reply_to: "admin@edupolicy.ai",
        }),
      }),
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "SAM Chief of Staff <booking@edupolicy.ai>",
          to: ["admin@edupolicy.ai", "dh30111@yahoo.com"],
          subject: `New Booking: ${type} — ${name} — ${date}`,
          html: adminHtml,
          reply_to: email,
        }),
      }),
    ]);

    const clientData = await clientResp.json();
    const adminData = await adminResp.json();

    // Honest outcome: Resend returns 200 on accept, 4xx on error.
    // Previously returned success:true regardless of Resend response — so if
    // a recipient was rejected or the API key was bad, caller saw success.
    const bothOk = clientResp.ok && adminResp.ok;
    const anyOk = clientResp.ok || adminResp.ok;
    return new Response(
      JSON.stringify({
        success: bothOk,
        partial: !bothOk && anyOk,
        clientSent: clientResp.ok,
        adminSent: adminResp.ok,
        clientEmailId: clientData.id,
        adminEmailId: adminData.id,
        clientError: clientResp.ok ? null : (clientData.message || "Resend rejected client email"),
        adminError: adminResp.ok ? null : (adminData.message || "Resend rejected admin email"),
      }),
      { status: bothOk ? 200 : (anyOk ? 207 : 500), headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Email error:", err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

export const config: Config = {
  path: "/api/send-confirmation",
};
