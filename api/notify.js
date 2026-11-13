/* /api/notify: server endpoint for the Tool Lending Library notify module.
   Prepared Nov 13, 2026 as a ready-to-deploy stub while Supabase and Resend
   setup finish. Deploy by copying this file to api/notify.js at the repo
   root (Vercel turns it into a serverless function automatically).

   The client (index.html, notify module, "resend" transport) POSTs:
     { to, cc, subject, body }   (cc may be "")
   This endpoint sends it through the Resend API with the key held
   server-side, never in the browser.

   Environment variables (Vercel project settings):
     RESEND_API_KEY  required for real sends. Without it the endpoint runs
                     in stub mode: it validates the message, logs it, and
                     returns { ok: true, stub: true } with HTTP 200 so the
                     client flow never breaks before the key exists.
     MAIL_FROM       optional. Default:
                     "Tool Lending Library <notifications@toollendinglibrary.com>"
                     The domain must be verified in Resend for real sends.

   Security posture: this is a neighborhood tool library notice sender.
   It only sends plain-text mail composed by the app, caps field sizes,
   sends to at most one To and one Cc address per call, and never echoes
   the API key. Tighten with a shared secret header if abuse appears. */

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "Tool Lending Library <notifications@toollendinglibrary.com>";
const MAX_TO = 200;
const MAX_SUBJECT = 300;
const MAX_BODY = 20000;

function isPlausibleEmail(value) {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 65536) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  let message;
  try {
    const raw = typeof req.body === "string" ? req.body : (req.body ? JSON.stringify(req.body) : await readBody(req));
    message = typeof req.body === "object" && req.body !== null ? req.body : JSON.parse(raw || "{}");
  } catch (e) {
    res.status(400).json({ ok: false, error: "Invalid JSON body" });
    return;
  }

  const to = String(message.to || "").trim().slice(0, MAX_TO);
  const cc = String(message.cc || "").trim().slice(0, MAX_TO);
  const subject = String(message.subject || "").trim().slice(0, MAX_SUBJECT);
  const body = String(message.body || "").slice(0, MAX_BODY);

  if (!isPlausibleEmail(to)) {
    res.status(400).json({ ok: false, error: "A valid recipient (to) is required" });
    return;
  }
  if (cc && !isPlausibleEmail(cc)) {
    res.status(400).json({ ok: false, error: "The cc address is not valid" });
    return;
  }
  if (!subject || !body) {
    res.status(400).json({ ok: false, error: "Subject and body are required" });
    return;
  }

  const apiKey = process.env.RESEND_API_KEY || "";
  const from = process.env.MAIL_FROM || DEFAULT_FROM;

  if (!apiKey) {
    console.log("[STUB NOTIFY] RESEND_API_KEY not set, message not sent:", { to, cc, subject });
    res.status(200).json({ ok: true, stub: true, note: "RESEND_API_KEY is not set on the server, so this message was composed and logged but not sent." });
    return;
  }

  try {
    const payload = { from, to: [to], subject, text: body };
    if (cc) payload.cc = [cc];
    const sendRes = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const result = await sendRes.json().catch(() => ({}));
    if (!sendRes.ok) {
      console.error("Resend send failed:", sendRes.status, result);
      res.status(502).json({ ok: false, error: "Email provider returned " + sendRes.status });
      return;
    }
    res.status(200).json({ ok: true, id: result.id || null });
  } catch (e) {
    console.error("Notify endpoint error:", e);
    res.status(502).json({ ok: false, error: "Email send failed" });
  }
};
