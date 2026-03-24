// @ts-nocheck
require("dotenv").config();

// Configure Crawlee - use temp storage per run
const fs = require("fs");
const os = require("os");
const path = require("path");
const crawleeRoot = path.join(os.tmpdir(), "seek-job-notification-crawlee");
fs.mkdirSync(crawleeRoot, { recursive: true }); // recursively create the directory
process.env.CRAWLEE_STORAGE_DIR = crawleeRoot;
process.env.CRAWLEE_PERSIST_STORAGE = "false";

// Import dependencies / modules 
const express = require("express");
const cors = require("cors");
const { Resend } = require("resend");
const { scrapeSeekJobs } = require("./scrapeSeek");
const { getSupabase } = require("./supabaseClient");

//Build CSV from jobs 
function buildJobsCsv(jobs) {
  //Guard clause if no jobs 
  if (!Array.isArray(jobs) || jobs.length === 0) return "";
  
  const escape = (v) => {
    if (v == null) return "";
    const s = String(v).trim();
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const headers = ["Job Title", "Company", "Location", "Salary", "Seek Url"];
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

/** Split comma / semicolon / newline separated emails into a clean list. */
function parseRecipientList(input) {
  if (input == null) return [];
  if (Array.isArray(input)) {
    return input
      .flatMap((s) => String(s).split(/[,\n;]+/))
      .map((e) => e.trim())
      .filter(Boolean);
  }
  return String(input)
    .split(/[,\n;]+/)
    .map((e) => e.trim())
    .filter(Boolean);
}

/** Very light check; supports "Name <email@domain.com>" or plain email. */
function validateEmailAddress(s) {
  const t = String(s).trim();
  if (!t || !t.includes("@")) return false;
  const m = t.match(/<([^>]+)>\s*$/);
  const addr = m ? m[1].trim() : t;
  return /^[^\s<>"']+@[^\s<>"']+\.[^\s<>"']+$/.test(addr);
}


const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Body: { searchString, location, emailFrom?, emailTo? }
app.post("/api/extract", async (req, res) => {
  const {
    searchString,
    location,
    emailFrom,
    emailTo,
  } = req.body || {};
  
  //Guard clause if no search string 
  if (!searchString || typeof searchString !== "string") {
    return res.status(400).json({ error: "search String is required" });
  }

  const normalizedLocation = typeof location === "string" ? location.trim() : "";

  // eslint-disable-next-line no-console
  console.log(
    `[api/extract] searchString="${searchString}" location="${normalizedLocation}"`,
  );

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

      // NOTE: intentionally disabled `seek_jobs` persistence.
      // Keeping this block commented for easy rollback.
      // let data = null;
      // if (payload.length > 0) {
      //   const upsertResult = await supabase
      //     .from("seek_jobs")
      //     .upsert(payload, { onConflict: "job_url" })
      //     .select();
      //   if (upsertResult.error) throw upsertResult.error;
      //   data = upsertResult.data;
      // }
      // insertedOrUpdated = data?.length ?? 0;
      //insertedOrUpdated = 0;

      // Load key metrics to the database
      
      const runPayload = {
        search_string: searchString,
        location: normalizedLocation || null,
        ui_reported_count:
          typeof debug?.scrapedJobsPreDedup === "number"
            ? debug.scrapedJobsPreDedup
            : null,
        final_returned_count: jobs.length,
        run_id: debug?.runId ?? null,
        debug: debug ?? null,
      };

      // write key metrics to the database
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

    const fromEmail =
      (typeof emailFrom === "string" && emailFrom.trim()) || "Seek Jobs <marcus.wong@linktal.com.au>";


    let toList = parseRecipientList(emailTo != null ? emailTo : []);

    const toFiltered = toList.filter(validateEmailAddress).slice(0, 50);

    //checking api key, scraped jobs & num of recipients 
    if (resendKey && jobs.length > 0 && toFiltered.length > 0) {
      try {
        const resend = new Resend(resendKey);
        const csv = buildJobsCsv(jobs);
        const filename = `seek-jobs-${searchString}-${normalizedLocation}.csv`;
        const { error: emailError } = await resend.emails.send({
          from: fromEmail,
          to: toFiltered,
          subject: `Seek jobs export (${jobs.length} jobs)`,
          text: `CSV Attachment with ${jobs.length} jobs from Seek.`,
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

    // return scrape results 
    return res.json({
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

