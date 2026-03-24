// @ts-nocheck
require("dotenv").config();

// Before any module loads Crawlee: never use ./server/storage (broken KV indexes).
const fs = require("fs");
const os = require("os");
const path = require("path");
const crawleeRoot = path.join(os.tmpdir(), "seek-job-notification-crawlee");
fs.mkdirSync(crawleeRoot, { recursive: true });
process.env.CRAWLEE_STORAGE_DIR = crawleeRoot;
process.env.CRAWLEE_PERSIST_STORAGE = "false";

const express = require("express");
const cors = require("cors");
const { Resend } = require("resend");

const { scrapeSeekJobs } = require("./scrapeSeek");
const { getSupabase } = require("./supabaseClient");

/** Build CSV string from jobs (same columns as frontend download). */
function buildJobsCsv(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) return "";
  const escape = (v) => {
    if (v == null) return "";
    const s = String(v).trim();
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const headers = ["Job Title", "Company", "Location", "Salary", "Job Url"];
  const rows = jobs.map((j) =>
    [
      escape(j.jobTitle),
      escape(j.company),
      escape(j.location),
      escape(j.salary),
      escape(j.jobUrl),
    ].join(","),
  );
  return [headers.join(","), ...rows].join("\r\n");
}

/** Split comma/newline/semicolon-separated emails into a unique trimmed list. */
function parseRecipientList(value, envFallback) {
  const raw =
    value !== undefined && value !== null && String(value).trim() !== ""
      ? value
      : envFallback || "";
  const parts = Array.isArray(raw)
    ? raw.flatMap((x) => String(x).split(/[,\n;]+/))
    : String(raw).split(/[,\n;]+/);
  return [...new Set(parts.map((e) => e.trim()).filter(Boolean))];
}

function isLooseValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Body: { searchString, location, emailFrom?, emailTo? | emailRecipients? }
app.post("/api/extract", async (req, res) => {
  const { searchString, location, emailFrom, emailTo, emailRecipients } =
    req.body || {};
  if (!searchString || typeof searchString !== "string") {
    return res.status(400).json({ error: "search String is required" });
  }
  const normalizedLocation =
    typeof location === "string" ? location.trim() : "";

  // eslint-disable-next-line no-console
  console.log(
    `[api/extract] searchString="${searchString}" location="${normalizedLocation}"`,
  );


  const resolvedFrom =
    (typeof emailFrom === "string" && emailFrom.trim()) || "Marcus Wong <marcus.wong@linktal.com.au>";
  const recipientList = parseRecipientList(emailTo !== undefined ? emailTo : emailRecipients);
    
  const invalidRecipients = recipientList.filter((e) => !isLooseValidEmail(e));
  if (invalidRecipients.length > 0) {
    return res.status(400).json({
      error: `Invalid recipient email(s): ${invalidRecipients.join(", ")}`,
    });
  }
  if (recipientList.length > 50) {
    return res.status(400).json({
      error: "Too many recipients (Resend allows max 50 per email).",
    });
  }

  try {
    const headless = process.env.PLAYWRIGHT_HEADLESS !== "false";

    const { jobs, debug } = await scrapeSeekJobs({
      searchString,
      location: normalizedLocation,
      headless,
    });

    const supabaseEnabled =
      Boolean(process.env.SUPABASE_URL) &&
      Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);

    let insertedOrUpdated = null;
    let scrapeRunId = null;
    if (supabaseEnabled) {
      const supabase = getSupabase();
      const payload = jobs.map((j) => ({
        job_title: j.jobTitle,
        company: j.company,
        location: j.location,
        salary: j.salary,
        job_url: j.jobUrl,
      }));

      let data = null;
      if (payload.length > 0) {
        const upsertResult = await supabase
          .from("seek_jobs")
          .upsert(payload)
          .select();
        if (upsertResult.error) throw upsertResult.error;
        data = upsertResult.data;
      }
      
      console.log("Data: ",data);
      console.log("Payload: ",payload);
      console.log("Upsert Result: ", upsertResult);

      insertedOrUpdated = data?.length ?? 0;

      // Per-run analytics row (backtest / performance). Does not fail the API if insert fails.
      const runPayload = {
        search_string: searchString,
        location: normalizedLocation || null,
        // Pre-final-dedupe count from scraper (vs jobs.length after uniqueByJobUrl).
        ui_reported_count:
          typeof debug?.scrapedJobsPreDedup === "number"
            ? debug.scrapedJobsPreDedup
            : null,
        final_returned_count: jobs.length,
        inserted_or_updated: insertedOrUpdated,
        run_id: debug?.runId ?? null,
        debug: debug ?? null,
      };
      const { data: runRow, error: runError } = await supabase
        .from("seek_scrape_runs")
        .insert(runPayload)
        .select("id")
        .single();
      if (runError) {
        // eslint-disable-next-line no-console
        console.error("[api/extract] seek_scrape_runs insert failed:", runError);
      } else {
        scrapeRunId = runRow?.id ?? null;
      }
    }

    let emailSent = null;
    const resendKey = process.env.RESEND_API_KEY?.trim();

    if (resendKey && jobs.length > 0) {
      try {
        const resend = new Resend(resendKey);
        const csv = buildJobsCsv(jobs);
        const filename = `seek-jobs-${Date.now()}.csv`;
        const { error: emailError } = await resend.emails.send({
          from: resolvedFrom,
          to: recipientList,
          subject: `Seek jobs export (${jobs.length} jobs)`,
          text: `Attached CSV with ${jobs.length} jobs from Seek.`,
          attachments: [
            {
              filename,
              content: Buffer.from(csv, "utf-8"),
            },
          ],
        });
        if (emailError) {
          // eslint-disable-next-line no-console
          console.error("[api/extract] Resend error:", emailError);
          emailSent = false;
        } else {
          emailSent = true;
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[api/extract] Resend exception:", e);
        emailSent = false;
      }
    }

    // Always return scraped results + debug. Only write to Supabase if enabled.
    return res.json({
      insertedOrUpdated,
      jobs,
      debug,
      ...(scrapeRunId && { scrapeRunId }),
      ...(emailSent !== null && { emailSent }),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});

