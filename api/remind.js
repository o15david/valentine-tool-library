/* /api/remind: due-date reminder sender for the Tool Lending Library (improvement S1).
   Added Nov 13, 2026. A GET or POST endpoint meant to be pinged once a day
   by an external cron (see the "Reminders cron" section of phase2/README.md).

   What it does:
     - Reads checked-out loans (borrow_requests with status approved or
       checked_out and a due_at) from Supabase over REST.
     - Day-before reminder: a loan due within the next 24 hours whose
       reminder_day_before_sent flag is still false gets a friendly email
       to the borrower, and the flag is set so it is sent at most once.
     - Overdue note: a loan past its due time whose reminder_overdue_sent
       flag is still false gets the overdue wording, once.
     - Loans whose borrower contact is not an email address are skipped.
     - Sends go through the Resend API, same as /api/notify.

   Environment variables (Vercel project settings):
     REMIND_SECRET            required for real runs. Callers pass it as the
                              x-remind-secret header, an Authorization Bearer
                              token, or a ?secret= query parameter. When it is
                              NOT set, the endpoint runs in stub mode: it
                              validates what it can, logs, and returns
                              { ok: true, stub: true } without touching data,
                              exactly like /api/notify without a key.
     SUPABASE_URL             the project URL.
     SUPABASE_SERVICE_ROLE_KEY  preferred for the REST reads and flag updates.
     SUPABASE_ANON_KEY        fallback when no service role key is set (works
                              while the permissive starting RLS policies last).
     RESEND_API_KEY           required to actually send. Without it, sends
                              are logged as stubs and flags are NOT set, so a
                              later configured run can still send them.
     MAIL_FROM                optional. Default matches /api/notify:
                              "Tool Lending Library <notifications@toollendinglibrary.com>"

   A standalone cron alternative, reminder_check.js, lives in phase2/ and
   does the same job from a scheduled script through /api/notify. Use one
   mechanism or the other, not both, or borrowers get duplicates (the flags
   are shared, so a loan marked by one will not be re-sent by the other). */

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "Tool Lending Library <notifications@toollendinglibrary.com>";
const DAY_MS = 24 * 60 * 60 * 1000;

function isPlausibleEmail(value) {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function fmtDue(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric" }) +
    ", " + d.toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const secret = process.env.REMIND_SECRET || "";
  const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
  const resendKey = process.env.RESEND_API_KEY || "";
  const from = process.env.MAIL_FROM || DEFAULT_FROM;

  if (!secret) {
    console.log("[STUB REMIND] REMIND_SECRET not set, reminder run skipped.");
    res.status(200).json({ ok: true, stub: true, note: "REMIND_SECRET is not set on the server, so no reminders were checked or sent." });
    return;
  }

  const url = new URL(req.url || "/", "http://localhost");
  const provided = req.headers["x-remind-secret"] ||
    (String(req.headers.authorization || "").startsWith("Bearer ") ? String(req.headers.authorization).slice(7) : "") ||
    url.searchParams.get("secret") || "";
  if (provided !== secret) {
    res.status(401).json({ ok: false, error: "Bad or missing remind secret" });
    return;
  }

  if (!supabaseUrl || !supabaseKey) {
    console.log("[STUB REMIND] SUPABASE_URL or a Supabase key is not set, reminder run skipped.");
    res.status(200).json({ ok: true, stub: true, note: "Supabase is not configured on the server, so no reminders were checked or sent." });
    return;
  }

  const sbHeaders = {
    "apikey": supabaseKey,
    "Authorization": "Bearer " + supabaseKey,
    "Content-Type": "application/json"
  };

  try {
    const listRes = await fetch(supabaseUrl + "/rest/v1/borrow_requests?status=in.(checked_out)&due_at=not.is.null&select=id,tool_id,borrower_name,borrower_contact,due_at,reminder_day_before_sent,reminder_overdue_sent", { headers: sbHeaders });
    if (!listRes.ok) throw new Error("Supabase list returned " + listRes.status);
    const loans = await listRes.json();

    const toolIds = [...new Set(loans.map(l => l.tool_id).filter(Boolean))];
    const toolNames = {};
    if (toolIds.length) {
      const toolsRes = await fetch(supabaseUrl + "/rest/v1/tools?id=in.(" + toolIds.map(encodeURIComponent).join(",") + ")&select=id,name", { headers: sbHeaders });
      if (toolsRes.ok) {
        (await toolsRes.json()).forEach(t => { toolNames[t.id] = t.name; });
      }
    }

    const now = Date.now();
    const summary = { checked: loans.length, dueSoonSent: 0, overdueSent: 0, skipped: 0, stubbed: 0 };

    for (const loan of loans) {
      const dueMs = new Date(loan.due_at).getTime();
      if (isNaN(dueMs)) { summary.skipped++; continue; }
      let kind = "";
      let flag = "";
      if (dueMs < now && !loan.reminder_overdue_sent) { kind = "overdue"; flag = "reminder_overdue_sent"; }
      else if (dueMs >= now && dueMs - now <= DAY_MS && !loan.reminder_day_before_sent) { kind = "due_soon"; flag = "reminder_day_before_sent"; }
      if (!kind) { summary.skipped++; continue; }

      const to = String(loan.borrower_contact || "").trim();
      if (!isPlausibleEmail(to)) { summary.skipped++; continue; }

      const toolName = toolNames[loan.tool_id] || "your borrowed tool";
      const dueText = fmtDue(loan.due_at);
      const subject = kind === "overdue"
        ? "Tool Lending Library: " + toolName + " is past due"
        : "Tool Lending Library: " + toolName + " is due back soon";
      const body = kind === "overdue"
        ? ["Hello " + (loan.borrower_name || "member") + ",",
           "",
           "A friendly note that " + toolName + " from the Tool Lending Library was due back " + dueText + " and is now past due.",
           "Please arrange its return with the lender as soon as you can, so the next member can use it.",
           "",
           "Thanks for being part of the library."].join("\n")
        : ["Hello " + (loan.borrower_name || "member") + ",",
           "",
           "A friendly heads-up that " + toolName + " from the Tool Lending Library is due back " + dueText + ".",
           "Please have it clean and ready to return by then, and thanks for borrowing.",
           "",
           "Valentine Tool Library, run by members, for members"].join("\n");

      if (!resendKey) {
        console.log("[STUB REMIND] RESEND_API_KEY not set, would send " + kind + " reminder to " + to + " for loan " + loan.id);
        summary.stubbed++;
        continue;
      }

      const sendRes = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: { "Authorization": "Bearer " + resendKey, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, text: body })
      });
      if (!sendRes.ok) {
        console.error("Remind send failed for loan " + loan.id + ":", sendRes.status);
        summary.skipped++;
        continue;
      }

      const patch = {};
      patch[flag] = true;
      const patchRes = await fetch(supabaseUrl + "/rest/v1/borrow_requests?id=eq." + encodeURIComponent(loan.id), {
        method: "PATCH",
        headers: Object.assign({}, sbHeaders, { "Prefer": "return=minimal" }),
        body: JSON.stringify(patch)
      });
      if (!patchRes.ok) console.error("Remind flag update failed for loan " + loan.id + ":", patchRes.status);

      if (kind === "overdue") summary.overdueSent++; else summary.dueSoonSent++;
    }

    res.status(200).json({ ok: true, summary });
  } catch (e) {
    console.error("Remind endpoint error:", e);
    res.status(502).json({ ok: false, error: "Reminder run failed" });
  }
};
