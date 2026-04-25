# Resend Domain Verification — edupolicy.ai

**Why this matters:** Right now, every email SAM sends from `briefing@edupolicy.ai` lands in your spam folder. M365 (your inbox provider) is rejecting them because Resend (the actual sender) isn't authorized to send mail from your domain. This is a DNS plumbing problem, not a code problem. SAM works perfectly — the mail just gets filtered.

**Time required:** 10 minutes of clicking, then 1–48 hours of DNS propagation (usually under 4 hours).

---

## Step 1 — Log into Resend and add the domain

1. Open https://resend.com/login. Log in with the account where your `RESEND_API_KEY` was generated.
2. In the left sidebar click **Domains**.
3. Hit **Add Domain**, enter `edupolicy.ai`, region **us-east-1** (or whichever you prefer — keep it consistent).
4. Click **Add**.

Resend will show you **3 to 4 DNS records** to add. They look like this (your actual values will be different — copy yours, not these):

```
Type   Host                                Value
CNAME  resend._domainkey                   resend._domainkey.amazonses.com
CNAME  s1._domainkey                       <unique long string>.amazonses.com
CNAME  s2._domainkey                       <unique long string>.amazonses.com
TXT    @  (or root domain)                 v=spf1 include:amazonses.com ~all
```

Some setups also include:
```
MX     send                                feedback-smtp.us-east-1.amazonses.com  (priority 10)
```

**Leave that page open. You will need to copy each record into GoDaddy.**

---

## Step 2 — Add the records at GoDaddy

1. Open https://dcc.godaddy.com/domains. Log in.
2. Click **edupolicy.ai** → **DNS** → **Manage Zones** (or **DNS Records**).
3. For each record Resend showed you, click **ADD** and create it:

   - **CNAME records**: Set Type = CNAME, Name = the host (e.g., `resend._domainkey` — GoDaddy will append `.edupolicy.ai` for you, do NOT type the full domain), Value = the long Resend value, TTL = 1 Hour.
   - **TXT record**: Set Type = TXT, Name = `@` (means root domain), Value = the SPF string (`v=spf1 include:amazonses.com ~all`), TTL = 1 Hour.

   **CRITICAL gotcha**: GoDaddy may already have an existing SPF (TXT) record at `@`. **Do not create a second one.** SPF must be a single TXT record. If one exists, edit it to merge in `include:amazonses.com`. Example existing record:
   ```
   v=spf1 include:_spf.google.com ~all
   ```
   merges to:
   ```
   v=spf1 include:_spf.google.com include:amazonses.com ~all
   ```
   Multiple SPF records will fail verification silently.

4. Save each record.

---

## Step 3 — Verify in Resend

1. Go back to the Resend Domains page.
2. Click **Verify DNS Records** on the edupolicy.ai entry.
3. Each record will show one of: ✓ verified, ⏳ pending, ✗ failed.
4. If any show pending after a few minutes, give DNS up to 4 hours to propagate. Check again. Repeat.
5. When all records are ✓ green, the domain status flips to **Verified**.

You can speed-check propagation with: https://mxtoolbox.com/SuperTool.aspx → enter `_domainkey.edupolicy.ai` (DKIM lookup) and `edupolicy.ai` (SPF lookup).

---

## Step 4 — Add a DMARC record (recommended, not strictly required)

This tells receiving inboxes what to do with mail that fails SPF/DKIM. Go back to GoDaddy DNS:

```
Type   Host        Value
TXT    _dmarc      v=DMARC1; p=quarantine; rua=mailto:admin@edupolicy.ai; pct=100; aspf=s; adkim=s
```

Once that's in place, your domain reputation builds faster and inbox placement improves.

---

## Step 5 — Test the briefing again

Once the domain is verified in Resend:

1. Visit https://sam-chief-of-staff.netlify.app
2. Click 🌅 **Brief Me Now** on the dashboard.
3. Wait ~25 seconds. You should see ✓ Briefing emailed toast.
4. Check `admin@edupolicy.ai` inbox. The briefing should land in **Inbox**, not Junk.
5. If it still lands in Junk, right-click → **Mark as Not Junk** → **Add sender to Safe Senders list**. M365 sometimes needs human-trained signal in addition to passing SPF/DKIM, especially for new sender domains.

---

## What you should NOT do

- **Don't change the FROM address.** SAM is hard-coded to send from `briefing@edupolicy.ai`. The whole point is to make THAT address authorized. Changing it breaks the whole flow.
- **Don't delete the existing `RESEND_API_KEY` env var.** It already works; this is purely a DNS-layer fix.
- **Don't add multiple SPF records.** Edit/merge instead.

---

## If verification fails after 24 hours

The most common causes, in order:
1. SPF record was created twice (delete the duplicate, keep one merged record).
2. CNAME values were typed with `.edupolicy.ai` appended at the end (GoDaddy auto-appends, so a typed-in full domain becomes `resend._domainkey.edupolicy.ai.edupolicy.ai`). Edit and remove the trailing domain.
3. TTL was set unusually high (24+ hours). Drop to 1 Hour, save again.
4. Resend region mismatch — DKIM CNAMEs are region-specific. Reread the Resend dashboard values and re-paste.

---

**Bottom line:** Your code is fine. Your mail server is fine. You just need to publish three DNS records that say "Resend is allowed to send from this domain" and one DNS record that says "here's how to verify they're really us." Once those propagate, the spam problem is permanently solved.
