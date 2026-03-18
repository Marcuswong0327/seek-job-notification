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

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Body: { searchString: string, location: string }
app.post("/api/extract", async (req, res) => {
  const { searchString, location } = req.body || {};
  if (!searchString || typeof searchString !== "string") {
    return res.status(400).json({ error: "search String is required" });
  }
  const normalizedLocation =
    typeof location === "string" ? location.trim() : "";

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
    if (supabaseEnabled) {
      const supabase = getSupabase();
      const payload = jobs.map((j) => ({
        job_title: j.jobTitle,
        company: j.company,
        location: j.location,
        salary: j.salary,
        job_url: j.jobUrl,
      }));

      const { data, error } = await supabase
        .from("seek_jobs")
        .upsert(payload, { onConflict: "job_url" })
        .select();

      if (error) throw error;
      insertedOrUpdated = data?.length || 0;
    }

    let emailSent = null;
    const resendKey = process.env.RESEND_API_KEY?.trim();
    const toEmail =
      process.env.SEEK_JOBS_RECIPIENT_EMAIL?.trim() ||
      "marcus.wong@linktal.com.au";
    const fromEmail =
      process.env.RESEND_FROM?.trim() || "Seek Jobs <onboarding@resend.dev>";

    if (resendKey && jobs.length > 0) {
      try {
        const resend = new Resend(resendKey);
        const csv = buildJobsCsv(jobs);
        const filename = `seek-jobs-${Date.now()}.csv`;
        const { error: emailError } = await resend.emails.send({
          from: fromEmail,
          to: [toEmail],
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
      ...(emailSent !== null && { emailSent }),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

const port = process.env.PORT;
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});

