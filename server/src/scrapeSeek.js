const path = require("path");
const fs = require("fs");
const os = require("os");
const {
  PlaywrightCrawler,
  Configuration,
  MemoryStorage,
} = require("crawlee");

/**
 * Seek scraper via Crawlee PlaywrightCrawler.
 * Each run uses a unique temp storage dir (timestamp + random) so the same
 * search never reuses broken server/storage KV state. Session pool is in-memory only.
 */

function _normalizeText(str) {
  if (!str) return str;
  return str
    .replace(/â€"/g, "-")
    .replace(/Â/g, "")
    .replace(/–/g, "-")
    .replace(/—/g, "-")
    .replace(/\u00C2\u00A0|\u00C2/g, "-");
}

function uniqueByJobUrl(jobs) {
  const seen = new Set();
  const out = [];
  for (const j of jobs) {
    if (!j.jobUrl) continue;
    if (seen.has(j.jobUrl)) continue;
    seen.add(j.jobUrl);
    out.push(j);
  }
  return out;
}

// Entry point for scraping Seek jobs
async function scrapeSeekJobs({ searchString, location, headless }) {
  const qSlug = encodeURIComponent(searchString);
  const rawLocation = (location || "").trim();

  const locationSlug = rawLocation
    ? rawLocation
        .replace(/\s+/g, "-")
        .replace(/[^\w-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
    : "";

  const url = locationSlug
    ? `https://www.seek.com.au/${qSlug}-jobs/in-${encodeURIComponent(locationSlug)}`
    : undefined;

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  const localDataDirectory = path.join(
    os.tmpdir(),
    "seek-job-notification-runs",
    runId,
  );
  fs.mkdirSync(localDataDirectory, { recursive: true });

  const memoryStorage = new MemoryStorage({
    localDataDirectory,
    persistStorage: false,
  });

  const config = new Configuration({
    storageClient: memoryStorage,
    purgeOnStart: true,
  });

  const results = [];
  const seenInRun = new Set();
  const debug = {
    runId,
    storageMode: "crawlee-memory-per-run",
    localDataDirectory,
    pagesVisited: 0,
    nextClicks: 0,
    scrapedJobsBeforeDedup: 0,
    scrapedJobsAfterDedup: 0,
    error: null
  };

  const extractJobsFromCurrentDom = async (page) => {
    return page.evaluate(() => {
      const out = [];
      const uniqueCards = new Set(); // detecting duplicate cards!!!
      const titleLinks = [
        ...document.querySelectorAll(
          'a[data-automation="jobTitle"], [data-testid="job-title"] a, h3 a[href*="/job/"], h2 a[href*="/job/"]',
        ),
      ];
      const getCard = (node) =>
        node.closest("article") || node.closest("li") || node.closest("div");

      for (const n of titleLinks) {
        const card = getCard(n);
        if (!card) continue;
        if (uniqueCards.has(card)) continue;

        uniqueCards.add(card);

        const jobData = {
          jobTitle: "",
          company: "",
          location: "",
          salary: "",
          jobUrl: "",
        };

        const linkedTitleSelectors = [
          'h3 a[data-automation="jobTitle"]',
          'a[data-automation="jobTitle"]',
          '[data-testid="job-title"] a',
          'h3 a[href*="/job"]',
          'h2 a[href*="/job"]',
        ];
        for (const selector of linkedTitleSelectors) {
          const el = card.querySelector(selector);
          if (el && el.href && el.textContent?.trim()) {
            jobData.jobTitle = el.textContent.trim();
            try {
              const u = new URL(el.href, window.location.origin);
              const m = u.pathname.match(/\/job\/(\d+)/i);
              jobData.jobUrl = m
                ? `${u.origin}/job/${m[1]}`
                : u.origin + u.pathname;
            } catch {
              jobData.jobUrl = el.href;
            }
            break;
          }
        }

        const companySelectors = [
          '[data-automation="jobCompany"] a',
          '[data-automation="jobCompany"]',
          "[data-testid=job-company]",
          ".company-name",
          "span[title]",
        ];
        for (const selector of companySelectors) {
          const el = card.querySelector(selector);
          if (el && el.textContent?.trim()) {
            jobData.company = el.textContent.trim();
            break;
          }
        }

        const locationSelectors = [
          '[data-automation="jobLocation"] a',
          '[data-automation="jobLocation"]',
          "[data-testid=job-location]",
          ".job-location",
          'span[data-automation="jobSuburb"]',
        ];
        for (const selector of locationSelectors) {
          const el = card.querySelector(selector);
          if (el && el.textContent?.trim()) {
            jobData.location = el.textContent.trim();
            break;
          }
        }

        const salarySelectors = [
          '[data-automation="jobSalary"]',
          "[data-testid=jobSalary]",
          "[data-testid=job-salary]",
          ".job-salary",
          ".salary",
          ".salary-info",
          ".salary-range",
          'span[data-automation="jobSalary"]',
        ];
        for (const selector of salarySelectors) {
          const el = card.querySelector(selector);
          if (el && el.textContent?.trim()) {
            jobData.salary = el.textContent.trim();
            break;
          }
        }

        if (jobData.jobUrl && jobData.jobUrl.startsWith("/")) {
          jobData.jobUrl = `https://www.seek.com.au${jobData.jobUrl}`;
        }
        out.push(jobData);
      }
      return out;
    });
  };

  const clickNextIfAvailable = async (page) => {
    return page.evaluate(() => {
      const nextButtons = [
        '[data-automation="page-next"]',
        'a[aria-label="Next"]',
        ".next",
        'a[aria-label="Go to next page"]',
        '[data-testid="pagination-next"]',
      ];
      for (const selector of nextButtons) {
        const button = document.querySelector(selector);
        if (
          button &&
          !button.disabled &&
          !button.classList.contains("disabled") &&
          !button.hasAttribute("aria-disabled")
        ) {
          button.click();
          return true;
        }
      }
      return false;
    });
  };

  
  // Implement scrolling feature to load more cards
  const warmUpLazyLoadedCards = async (page, pageIndex) => {
    const scrollRounds = 5;
    for (let i = 0; i < scrollRounds; i++) {
      await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.9)));
      await page.waitForTimeout(400);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
    const titleLinks = await page
      .$$eval('a[data-automation="jobTitle"]', (els) => els.length)
      .catch(() => 0);
    // eslint-disable-next-line no-console
    console.log(
      `[scrapeSeekJobs/crawlee] runId=${runId} lazyLoad pageIndex=${pageIndex} scrollRounds=${scrollRounds} titleLinks=${titleLinks}`,
    );
  };

  const crawler = new PlaywrightCrawler(
    {
      maxRequestsPerCrawl: 1,
      maxRequestRetries: 0,
      useSessionPool: true,
      sessionPoolOptions: {
        persistenceOptions: { enable: false },
      },
      navigationTimeoutSecs: 90,
      requestHandlerTimeoutSecs: 900,
      launchContext: {
        launchOptions: { headless: headless !== false },
      },
      preNavigationHooks: [
        async (_ctx, gotoOptions) => {
          gotoOptions.waitUntil = "networkidle";
        },
      ],
      async requestHandler({ page }) {
        await page.setViewportSize({ width: 1920, height: 1080 });
        // eslint-disable-next-line no-console
        console.log(`[scrapeSeekJobs/crawlee] runId=${runId} url="${url}"`);

        try {
          try {
            await page.waitForLoadState("networkidle", { timeout: 15000 });
          } catch {
            /* ignore */
          }
          await page.waitForSelector('a[data-automation="jobTitle"]', {
            timeout: 60000,
          });
          debug.initialJobTitles = await page.$$eval(
            'a[data-automation="jobTitle"]',
            (els) => els.length,
          );
        } catch (e) {
          debug.finalUrl = page.url();
          debug.error = e?.message || String(e);
          // eslint-disable-next-line no-console
          console.log(
            `[scrapeSeekJobs/crawlee] early failure runId=${runId} finalUrl="${debug.finalUrl}"`,
          );
          return;
        }

        const maxPages = 80;
        for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
          debug.pagesVisited = pageIndex + 1;
          await warmUpLazyLoadedCards(page, pageIndex);
          const jobsOnPage = await extractJobsFromCurrentDom(page);
          let newCount = 0;
          for (const j of jobsOnPage) {
            if (!j.jobUrl) continue;
            if (seenInRun.has(j.jobUrl)) continue;
            seenInRun.add(j.jobUrl);
            results.push(j);
            newCount++;
          }
          // eslint-disable-next-line no-console
          console.log(
            `[scrapeSeekJobs/crawlee] runId=${runId} pageIndex=${pageIndex} extracted=${jobsOnPage.length} newUnique=${newCount} total=${seenInRun.size} nextClicks=${debug.nextClicks}`,
          );

          const clicked = await clickNextIfAvailable(page);
          if (!clicked) break;
          debug.nextClicks++;

          const firstJobHrefBefore = await page
            .$eval('a[data-automation="jobTitle"]', (el) => el.href)
            .catch(() => null);
          const beforeUrl = page.url();
          await Promise.race([
            page
              .waitForURL((u) => u.toString() !== beforeUrl, { timeout: 15000 })
              .catch(() => null),
            page
              .waitForFunction(
                (href) => {
                  if (!href) return true;
                  const el = document.querySelector(
                    'a[data-automation="jobTitle"]',
                  );
                  return el && el.href && el.href !== href;
                },
                firstJobHrefBefore,
                { timeout: 20000 },
              )
              .catch(() => null),
            page.waitForTimeout(2000),
          ]);

          const jitterMs = 1200 + Math.floor(Math.random() * 1600);
          await page.waitForTimeout(jitterMs);
          try {
            await page.waitForSelector('a[data-automation="jobTitle"]', {
              timeout: 30000,
            });
          } catch {
            break;
          }
        }

        // eslint-disable-next-line no-console
        console.log(
          `[scrapeSeekJobs/crawlee] runId=${runId} done jobs=${results.length} pages=${debug.pagesVisited}`,
        );
      },
    },
    config,
  );

  try {
    await crawler.run([
      {
        url,
        uniqueKey: `seek-${runId}`,
      },
    ]);
  } finally {
    try {
      await memoryStorage.teardown();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(localDataDirectory, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  const cleaned = uniqueByJobUrl(
    results.map((j) => ({
      jobTitle: _normalizeText(j.jobTitle) || null,
      company: _normalizeText(j.company) || null,
      location: _normalizeText(j.location) || null,
      salary: _normalizeText(j.salary) || null,
      jobUrl: j.jobUrl || null,
    })),
  ).filter((j) => j.jobUrl);

  debug.scrapedJobsBeforeDedup = results.length;
  debug.scrapedJobsAfterDedup = cleaned.length;
  return { jobs: cleaned, debug };
}

module.exports = { scrapeSeekJobs };
