import React, { useState } from "react";

/** Escape a CSV cell (wrap in quotes if contains comma, quote, or newline). */
function csvEscape(value) {
  if (value == null) return "";
  const s = String(value).trim();
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Build CSV string and trigger download for jobs array. */
function downloadJobsCsv(jobs, filename = "seek-jobs.csv") {
  if (!Array.isArray(jobs) || jobs.length === 0) return;
  const headers = ["Job Title", "Company", "Location", "Salary", "Job Url"];
  const rows = jobs.map((j) =>
    [
      csvEscape(j.jobTitle),
      csvEscape(j.company),
      csvEscape(j.location),
      csvEscape(j.salary),
      csvEscape(j.jobUrl),
    ].join(","),
  );
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
  const [location, setLocation] = useState("New South Wales NSW");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  async function onExtract() {
    setLoading(true);
    setError("");
    setResult(null);

    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ searchString, location }),
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Extraction failed");
      setResult(json);
      if (Array.isArray(json.jobs) && json.jobs.length > 0) {
        const name = `seek-jobs-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}.csv`;
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
            placeholder="e.g. fitter"
            style={{ width: "100%", padding: 8, marginTop: 6 }}
          />
        </label>
        <label>
          Location
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="e.g. New South Wales NSW"
            style={{ width: "100%", padding: 8, marginTop: 6 }}
          />
        </label>
        <button onClick={onExtract} disabled={loading || !searchString}>
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

