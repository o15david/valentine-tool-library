/* /api/notify: server endpoint for the Tool Lending Library notify module.
   Prepared Nov 13, 2026 as a ready-to-deploy stub while Supabase and Resend
   setup finish. Deploy by copying this file to api/notify.js at the repo
   root (Vercel turns it into a serverless function automatically).

   The client (index.html, notify module, "resend" transport) POSTs:
     { to, cc, subject, body }   (cc may be "")
   Callers may also pass two optional branding fields:
     { libraryName, logoUrl }
   libraryName names the library the mail belongs to and logoUrl is
   that library's logo as an ABSOLUTE URL (email clients cannot load
   relative paths). Either one missing or unusable falls back to the
   platform branding: the name "Tool Lending Library" and the platform
   logo hosted on the platform domain. The reminder and notification
   checkers pass the same two fields, so every email the system sends
   is branded at this one point.
   This endpoint sends it through the Resend API with the key held
   server-side, never in the browser. Sends are multipart: the plain
   text part is the caller's body exactly as composed, and the HTML
   part is built from that same text by buildEmailHtml below (a clean
   header with the library's logo and name, the body as paragraphs,
   and a small footer naming the library).

   Environment variables (Vercel project settings):
     RESEND_API_KEY  required for real sends. Without it the endpoint runs
                     in stub mode: it validates the message, logs it, and
                     returns { ok: true, stub: true } with HTTP 200 so the
                     client flow never breaks before the key exists.
     MAIL_FROM       optional. Default:
                     "Tool Lending Library <notifications@toollendinglibrary.com>"
                     The domain must be verified in Resend for real sends.

   Security posture: this is a neighborhood tool library notice sender.
   It only sends mail composed by the app (the plain text as given,
   plus the branded HTML part built from that same text), caps field sizes,
   sends to at most one To and one Cc address per call, and never echoes
   the API key. Tighten with a shared secret header if abuse appears. */

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "Tool Lending Library <notifications@toollendinglibrary.com>";
const MAX_TO = 200;
const MAX_SUBJECT = 300;
const MAX_BODY = 20000;
const MAX_LIBRARY_NAME = 200;
const MAX_LOGO_URL = 1000;

/* Platform branding defaults (email branding, Nov 13, 2026). The
   platform logo files live on the platform domain next to the site;
   the 192px icon is the size the HTML header asks for. */
const DEFAULT_LIBRARY_NAME = "Tool Lending Library";
const PLATFORM_LOGO_URL = "https://toollendinglibrary.com/logo-icon-192.png";
const BRAND_BLUE = "#0366C0";
const FONT_STACK = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function isPlausibleEmail(value) {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/* The branding a send actually uses: the caller's library name and
   logo when they are usable, the platform name and logo otherwise.
   A logo counts only as an absolute http(s) URL with no characters
   that could break out of the src attribute; anything else (relative
   paths, data URLs, other schemes) falls back to the platform logo,
   because an email client could not load it anyway. */
function resolveBrand(fields) {
  const f = fields || {};
  const name = String(f.libraryName || "").trim().slice(0, MAX_LIBRARY_NAME) || DEFAULT_LIBRARY_NAME;
  const rawLogo = String(f.logoUrl || "").trim().slice(0, MAX_LOGO_URL);
  const logo = /^https?:\/\/[^\s"'<>]+$/i.test(rawLogo) ? rawLogo : PLATFORM_LOGO_URL;
  return { libraryName: name, logoUrl: logo };
}

/* The plain text body as HTML paragraphs: blank lines split
   paragraphs, single newlines become line breaks, and every
   character of the text is escaped first, so a body containing
   markup characters can never break the HTML part. */
function textToParagraphs(text) {
  const blocks = String(text == null ? "" : text).replace(/\r\n/g, "\n").split(/\n{2,}/);
  return blocks.map(block =>
    "<p style=\"margin:0 0 14px 0;\">" + escapeHtml(block).replace(/\n/g, "<br>") + "</p>"
  ).join("");
}

/* The branded HTML part, built from the same text as the plain part.
   Email-safe table layout, inline styles only, white background and
   neutral grays matching the site, a header with the library's logo
   beside its name, a thin brand-blue rule, the message as paragraphs,
   and a small muted footer naming the library. No other decoration
   and no marketing copy. Exported for the tests (notify_test.js). */
function buildEmailHtml(fields) {
  const f = fields || {};
  const brand = resolveBrand(f);
  const name = escapeHtml(brand.libraryName);
  const logo = escapeHtml(brand.logoUrl);
  return "<!DOCTYPE html>\n" +
    "<html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    "<title>" + name + "</title></head>" +
    "<body style=\"margin:0; padding:0; background-color:#ffffff;\">" +
    "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"background-color:#ffffff;\">" +
    "<tr><td align=\"center\" style=\"padding:0;\">" +
    "<table role=\"presentation\" width=\"600\" cellpadding=\"0\" cellspacing=\"0\" style=\"width:100%; max-width:600px;\">" +
    "<tr><td style=\"padding:24px 24px 14px 24px;\">" +
    "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\"><tr>" +
    "<td style=\"vertical-align:middle;\"><img src=\"" + logo + "\" alt=\"" + name + "\" height=\"40\" style=\"display:block; height:40px; border:0; outline:none; text-decoration:none;\"></td>" +
    "<td style=\"vertical-align:middle; padding-left:12px; font-family:" + FONT_STACK + "; font-size:19px; font-weight:600; color:#111827;\">" + name + "</td>" +
    "</tr></table>" +
    "</td></tr>" +
    "<tr><td style=\"padding:0 24px;\"><table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\"><tr><td style=\"background-color:" + BRAND_BLUE + "; height:2px; line-height:2px; font-size:0;\">&nbsp;</td></tr></table></td></tr>" +
    "<tr><td style=\"padding:20px 24px 6px 24px; font-family:" + FONT_STACK + "; font-size:15px; line-height:1.6; color:#1f2937;\">" +
    textToParagraphs(f.body) +
    "</td></tr>" +
    "<tr><td style=\"padding:14px 24px 24px 24px; border-top:1px solid #e5e7eb; font-family:" + FONT_STACK + "; font-size:12px; color:#6b7280;\">" + name + "</td></tr>" +
    "</table>" +
    "</td></tr></table>" +
    "</body></html>";
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

async function notifyHandler(req, res) {
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
  /* Optional branding (libraryName, logoUrl); resolveBrand applies
     the platform defaults when the caller passed neither. The HTML
     part is built from the same (capped) body as the text part. */
  const brand = resolveBrand(message);
  const html = buildEmailHtml({ libraryName: brand.libraryName, logoUrl: brand.logoUrl, body: body });

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
    const payload = { from, to: [to], subject, text: body, html: html };
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
}

module.exports = notifyHandler;
/* Exported for notify_test.js; Vercel uses the handler itself. */
module.exports.buildEmailHtml = buildEmailHtml;
module.exports.escapeHtml = escapeHtml;
module.exports.resolveBrand = resolveBrand;
module.exports.PLATFORM_LOGO_URL = PLATFORM_LOGO_URL;
module.exports.DEFAULT_LIBRARY_NAME = DEFAULT_LIBRARY_NAME;
