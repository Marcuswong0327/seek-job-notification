import React, { useEffect, useState } from "react";

const LS_FROM = "seekJobEmailFrom";
const LS_TO = "seekJobEmailRecipients";

const DEFAULT_FROM = "Marcus Wong <marcus.wong@linktal.com.au>";
const DEFAULT_RECIPIENTS = "marcus.wong@linktal.com.au";

/** Escape a CSV cell (wrap in quotes if contains comma, quote, or newline). */
function csvEscape(value) {
  if (value == null) return "";
  const s = String(value).trim();
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Build CSV string and trigger download for jobs array. */
function downloadJobsCsv(jobs, filename = "seek-jobs.csv") {

  // Guard clause
  if (!Array.isArray(jobs) || jobs.length === 0) return;
  
  const headers = ["Job Title", "Company", "Location", "Salary", "Seek Url"];
  const rows = jobs.map((j) =>
    [
      csvEscape(j.jobTitle),
      csvEscape(j.company),
      csvEscape(j.location),
      csvEscape(j.salary),
      csvEscape(j.jobUrl),
    ].join(","),
  );

  //blob = binary large object - convert raw text into a virtual file, 
  // use URL.creatObjectURL to create a fake web address  for the file 
  // create invisible HTML link <a> and attach fake web address 
  // tell browsers to click and download 
  // URL.revokeObjectURL - delete fake web address from memory, so free resources 
  const csv = [headers.join(","), ...rows].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function App() {
  const [searchString, setSearchString] = useState("");
  const [location, setLocation] = useState("");
  const [emailFrom, setEmailFrom] = useState(() => {
    try {
      return localStorage.getItem(LS_FROM) || DEFAULT_FROM;
    } catch {
      return DEFAULT_FROM;
    }
  });
  const [emailRecipients, setEmailRecipients] = useState(() => {
    try {
      return localStorage.getItem(LS_TO) || DEFAULT_RECIPIENTS;
    } catch {
      return DEFAULT_RECIPIENTS;
    }
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    try {
      localStorage.setItem(LS_FROM, emailFrom);
    } catch {
      /* ignore */
    }
  }, [emailFrom]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_TO, emailRecipients);
    } catch {
      /* ignore */
    }
  }, [emailRecipients]);

  async function onExtract() {
    setLoading(true);
    setError("");
    setResult(null);

    // api/extract is the window to enter into backend 
    // SEND REQUEST - POST 
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          searchString,
          location,
          emailFrom: emailFrom.trim(),
          emailTo: emailRecipients,
        }),
      });

      // WAIT FOR RESPONSE 
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || "Extraction failed");
      }
        setResult(json);

      // DOWNLOAD FILE
      if (Array.isArray(json.jobs) && json.jobs.length > 0) {
        const name = `seek-jobs-${searchString}-${location}.csv`;
        downloadJobsCsv(json.jobs, name);
      }
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: "40px auto", padding: 16 }}>
      <h2>Seek Job Extraction</h2>
      <div style={{ display: "grid", gap: 12 }}>
        <label>
          Search string
          <input
            value={searchString}
            onChange={(e) => setSearchString(e.target.value)}
            style={{ width: "100%", padding: 8, marginTop: 6 }}
          />
        </label>
        <label>
          Location
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            style={{ width: "100%", padding: 8, marginTop: 6 }}
          />
        </label>

        <fieldset>
          <legend>Email Notification</legend>
          <label style={{ display: "block" }}>
            Sender (From)
            <input
              value={emailFrom}
              onChange={(e) => setEmailFrom(e.target.value)}
              placeholder='Marcus Wong <marcus.wong@linktal.com.au>'
              style={{ width: "100%", padding: 8, marginTop: 6 }}
            />
          </label>
          <label style={{ display: "block", marginTop: 10 }}>
            Recipients (To) - use comma to separete, max 50 recipients per email
            <textarea
              value={emailRecipients}
              onChange={(e) => setEmailRecipients(e.target.value)}
              placeholder="one@linktal.com.au, two@example.com"
              rows={3}
              style={{
                width: "100%",
                padding: 8,
                marginTop: 6
              }}
            />
          </label>
        </fieldset>

        <button onClick={onExtract} disabled={loading || !searchString || !location}>
          {loading ? "Extracting..." : "Extract jobs"}
        </button>
      </div>

      {error ? (
        <pre style={{ marginTop: 16, color: "crimson" }}>{error}</pre>
      ) : null}

      {result ? (
        <pre style={{ marginTop: 16, background: "#f6f6f6", padding: 12 }}>
          {JSON.stringify(result, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

