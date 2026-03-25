# SEEK Scraper Architecture, Logic, and Data Flow

## 1) Purpose and scope

This project is a full-stack scraper workflow for SEEK job listings:

- `client` (React + Vite) collects user inputs and calls backend API.
- `server` (Express) orchestrates scraping, optional Supabase logging, and optional email delivery.
- `scrapeSeek.js` (Crawlee + Playwright) performs browser automation and extraction with pagination + dedupe.

This document explains the current architecture in a way that can be reused to build a second scraper for **SEEK Talent candidates** where logic is mostly the same but:

- entry URL/navigation differs,
- selectors differ,
- extracted field schema differs.

---

## 2) Repository structure

```text
seek-job-notification/
  package.json                  # Root scripts to run client/server
  client/
    package.json
    vite.config.js              # /api proxy -> backend
    src/
      main.jsx
      App.jsx                   # UI form + request + CSV download
  server/
    package.json
    src/
      index.js                  # API endpoint + orchestration
      scrapeSeek.js             # Crawlee/Playwright scraping engine
      supabaseClient.js         # Supabase client factory
```

---

## 3) Runtime components

## Frontend (`client/src/App.jsx`)

- Captures input:
  - `searchString`
  - `location`
  - `emailFrom`
  - `emailRecipients`
- Persists email fields in `localStorage`.
- Sends `POST /api/extract` JSON request.
- Receives `{ jobs, debug, scrapeRunId?, emailSent? }`.
- Triggers client-side CSV download from returned `jobs`.

## Backend API (`server/src/index.js`)

- Exposes:
  - `GET /health`
  - `POST /api/extract`
- Validates required input (`searchString`).
- Calls `scrapeSeekJobs({ searchString, location, headless })`.
- Optionally writes scrape run metrics to Supabase table `seek_scrape_runs`.
- Optionally sends CSV email via Resend when API key + recipients + jobs exist.
- Returns normalized response to UI.

## Scraper engine (`server/src/scrapeSeek.js`)

- Builds SEEK URL from `searchString` + `location`.
- Creates isolated run state using:
  - unique `runId`
  - temporary storage dir
  - `MemoryStorage` in Crawlee
- Launches `PlaywrightCrawler` with one starting URL.
- For each page:
  - waits for job cards
  - warms lazy-loaded content (scroll rounds)
  - extracts job records from card DOM
  - deduplicates by `jobUrl`
  - clicks next page if available
- Cleans text and returns final deduped results + debug metadata.

## Supabase client (`server/src/supabaseClient.js`)

- Creates service-role Supabase client from:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
- Used for server-side insert into `seek_scrape_runs`.

---

## 4) End-to-end data flow

1. User enters form in frontend and clicks extract.
2. Frontend sends `POST /api/extract` with query + email parameters.
3. Backend validates request and launches scraper.
4. Scraper navigates SEEK, paginates, extracts records, dedupes, returns `{ jobs, debug }`.
5. Backend optionally persists run metrics to Supabase.
6. Backend optionally builds CSV and sends it via Resend to recipients.
7. Backend returns JSON response.
8. Frontend renders JSON result and downloads CSV locally.

---

## 5) API contract (current)

## Request: `POST /api/extract`

```json
{
  "searchString": "developer",
  "location": "sydney",
  "emailFrom": "Marcus Wong <marcus.wong@linktal.com.au>",
  "emailTo": "one@example.com, two@example.com"
}
```

## Response (success)

```json
{
  "jobs": [
    {
      "jobTitle": "Software Engineer",
      "company": "Acme",
      "location": "Sydney NSW",
      "salary": "$100k - $120k",
      "jobUrl": "https://www.seek.com.au/job/12345678"
    }
  ],
  "debug": {
    "runId": "....",
    "pagesVisited": 3,
    "nextClicks": 2,
    "scrapedJobsBeforeDedup": 75,
    "scrapedJobsAfterDedup": 72
  },
  "scrapeRunId": 123,
  "emailSent": true
}
```

## Response (error)

```json
{
  "error": "search String is required"
}
```

---

## 6) Scraper logic details (current job scraper)

## URL construction

- Query slug:
  - `encodeURIComponent(searchString)`
- Location slug normalization:
  - spaces -> `-`
  - non-word chars -> `-`
  - collapse repeated hyphens
- URL pattern:
  - `https://www.seek.com.au/{query}-jobs/in-{location}`

## Extraction strategy

- Title anchor discovery uses broad fallback selectors.
- For each title node:
  - find nearest card container (`article` / `li` / `div`)
  - avoid duplicate card processing (`Set`)
  - extract fields via selector priority lists:
    - title + canonicalized URL
    - company
    - location
    - salary

## Pagination strategy

- Try multiple "next" selectors and click first valid.
- Stop loop when no next button is available.
- After click, wait for one of:
  - URL change,
  - first result item change,
  - timeout fallback.

## Anti-flake / stability behavior

- Wait for network idle.
- Wait for title selector before extraction.
- Scroll to trigger lazy-loaded cards.
- Random jitter between pages.
- Timeouts + guarded `try/catch` blocks.

## Deduplication and cleanup

- In-run dedupe on `jobUrl` while collecting.
- Final pass `uniqueByJobUrl`.
- `_normalizeText` to clean common mojibake characters.
- Return only rows with non-empty `jobUrl`.

---

## 7) Storage and observability

## Debug object

The scraper tracks:

- `runId`
- storage mode and temp directory
- pages visited
- next clicks
- pre/post dedupe counts
- failure info (`error`, `finalUrl` when available)

## Supabase write path

When env vars are present, backend inserts into `seek_scrape_runs`:

- `search_string`
- `location`
- `ui_reported_count` (from debug pre-dedupe count)
- `final_returned_count`
- `run_id`
- `debug` (JSON blob)

Note: upsert into `seek_jobs` is currently intentionally disabled/commented out.

---

## 8) Notification and CSV logic

## CSV generation

Both client and server implement CSV builders:

- headers: `Job Title, Company, Location, Salary, Seek Url`
- quote escaping for commas/quotes/newlines

## Email delivery path

Server sends email only if all are true:

- `RESEND_API_KEY` exists
- jobs array is non-empty
- at least one valid recipient (max 50)

Attachment is CSV in-memory buffer.

---

## 9) Configuration and environment variables

Used by server:

- `PORT` (default `3001`)
- `PLAYWRIGHT_HEADLESS` (`false` to run headed)
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `RESEND_API_KEY`

Vite dev proxy:

- frontend `/api/*` -> `http://localhost:3001`

---

## 10) Reusable scraper pattern for SEEK Talent candidates

The current implementation can be treated as a reusable template:

## Keep unchanged (or mostly unchanged)

- Express API pattern (`/api/extract` request/response lifecycle).
- Input validation + error handling.
- Crawlee + Playwright crawler skeleton.
- Pagination loop structure and next-button strategy.
- Lazy-load warm-up scrolling.
- In-run dedupe and final cleanup pipeline.
- Debug metrics collection.
- Optional Supabase run logging.
- Optional Resend email with CSV attachment.

## Replace/adapt for SEEK Talent

1. **Entry URL builder**
   - New base domain/path for candidate search.
   - Replace `searchString/location` slug logic with Talent query params or route rules.

2. **Authentication/session handling**
   - SEEK Talent may require login/account context.
   - Add login step (if required) in `preNavigationHooks` or early in `requestHandler`.
   - Consider secure credential sourcing from env vars.

3. **Candidate card selectors**
   - Replace job-specific selectors with candidate selectors.
   - Update extraction map to candidate schema.

4. **Canonical unique key**
   - Replace `jobUrl` dedupe key with stable candidate key:
     - `candidateProfileUrl`, or
     - `candidateId` parsed from URL/data attributes.

5. **Pagination controls**
   - Replace next-button selectors and page transition waits for Talent UI.

6. **Output schema**
   - New fields (example):
     - `candidateName`
     - `currentTitle`
     - `location`
     - `skillsSummary`
     - `experienceYears`
     - `availability`
     - `profileUrl`

7. **CSV columns + DB table**
   - Update CSV header mapping.
   - Add new table for candidate runs/results if persistence is needed.

---

## 11) Recommended candidate scraper module design

Create a parallel scraper module instead of modifying job scraper in-place:

- `server/src/scrapeSeekCandidates.js`
- Export `scrapeSeekCandidates({ searchString, location, headless, ...filters })`
- Add new endpoint:
  - `POST /api/extract-candidates`

This avoids regressions in existing job scraping while reusing shared utility patterns.

Suggested internal function layout:

- `buildCandidateSearchUrl(params)`
- `extractCandidatesFromCurrentDom(page)`
- `clickNextIfAvailable(page)`
- `warmUpLazyLoadedCards(page, pageIndex)`
- `normalizeCandidateRecord(record)`
- `uniqueByCandidateKey(records)`

---

## 12) Candidate data flow (target state)

1. UI collects candidate search filters.
2. UI calls `POST /api/extract-candidates`.
3. API invokes `scrapeSeekCandidates`.
4. Scraper loads Talent results, extracts candidate cards, paginates.
5. API dedupes/normalizes candidate records and builds debug metadata.
6. API optionally writes run metrics to `seek_candidate_scrape_runs`.
7. API optionally emails candidate CSV to recipients.
8. UI displays results and optionally downloads CSV.

---

## 13) Migration checklist (jobs -> candidates)

- [ ] Add `scrapeSeekCandidates.js` based on `scrapeSeek.js` skeleton.
- [ ] Implement Talent URL builder.
- [ ] Implement candidate selectors with fallback lists.
- [ ] Implement candidate unique key extraction.
- [ ] Add endpoint `POST /api/extract-candidates`.
- [ ] Add/adjust frontend form for candidate filters.
- [ ] Update CSV builder for candidate columns.
- [ ] Add Supabase tables for candidate run logging (optional).
- [ ] Add smoke tests for extraction + pagination + dedupe.

---

## 14) Risk areas when porting to SEEK Talent

- Login/session requirements may break anonymous scraping assumptions.
- DOM/selector instability is likely; keep fallback selectors and robust waits.
- Infinite scroll or virtualized lists may require stronger scrolling/wait logic.
- Anti-bot behavior may require lower request rate and retry/backoff strategy.
- Candidate profile URLs may be obfuscated; dedupe key selection is critical.

---

## 15) Practical implementation notes

- Start by cloning current scraper loop first, then replace selectors and fields.
- Add verbose debug counts early (candidate cards found vs accepted).
- Keep extraction pure and deterministic (DOM -> raw record -> normalized record).
- Avoid coupling extraction logic to email/DB paths; keep those in API layer.
- Maintain one "source of truth" output schema for UI, CSV, and DB mapping.

This architecture gives you a low-risk path to implement a SEEK Talent candidate scraper with minimal changes to the surrounding system.
