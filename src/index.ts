// Secrets Store bindings have an async .get() method
interface SecretStoreSecret {
  get(): Promise<string>;
}

interface Env {
  DB: D1Database;
  YAHOO_REPORTING: Fetcher; // Service binding to yahoo-report-worker
  FWP_YAHOO_REPORTING_API_KEY: SecretStoreSecret;
}

// --- Types ---

interface TickerStats {
  ticker: string;
  article_count: number;
  total_views: number;
  median_views_per_article: number;
  avg_views_per_article: number;
}

interface YahooNewsItem {
  uuid: string;
  title: string;
  publisher: string;
  link: string;
  providerPublishTime: number;
  type: string;
  relatedTickers?: string[];
}

interface CheckResult {
  top_publishers: { position: number; publisher: string; title: string }[];
  our_position: number | null;
  is_opportunity: boolean;
}

// --- User-Agent rotation (from Ticker Pulse patterns) ---

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0",
];

function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// --- Helpers ---

// Random delay between min and max milliseconds
function sleep(min: number, max: number): Promise<void> {
  const ms = min + Math.random() * (max - min);
  return new Promise((r) => setTimeout(r, ms));
}

// Check if a publisher name is ours (247wallstreet / 24/7 Wall St)
function isOurPublisher(publisher: string): boolean {
  if (!publisher) return false;
  const lower = publisher.toLowerCase();
  return (
    lower.includes("24/7 wall st") ||
    lower.includes("247 wall st") ||
    lower.includes("247wallst")
  );
}

// --- Yahoo Reporting API ---

// Uses the service binding to call Yahoo Reporting Worker directly (no public URL needed)
async function fetchHighValueTickers(
  env: Env,
  limit: number = 200
): Promise<TickerStats[]> {
  const apiKey = await env.FWP_YAHOO_REPORTING_API_KEY.get();

  // Service binding fetch uses relative URL, routed directly to the bound worker
  const res = await env.YAHOO_REPORTING.fetch(
    new Request("https://yahoo-report-worker/api/ticker-stats", {
      headers: { "X-API-Key": apiKey },
    })
  );

  if (!res.ok) {
    throw new Error(
      `Yahoo Reporting API returned ${res.status}: ${await res.text()}`
    );
  }

  const data = (await res.json()) as TickerStats[];

  // Sort by median views descending, take top N
  return data
    .filter((t) => t.median_views_per_article > 0)
    .sort((a, b) => b.median_views_per_article - a.median_views_per_article)
    .slice(0, limit);
}

// --- Yahoo Finance Search API ---

async function checkYahooFinance(ticker: string): Promise<CheckResult> {
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&quotesCount=1&newsCount=8`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": getRandomUserAgent(),
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(25000),
  });

  if (!res.ok) {
    throw new Error(`Yahoo Finance returned ${res.status} for ${ticker}`);
  }

  const data = (await res.json()) as { news?: YahooNewsItem[] };
  const news = data.news || [];

  // Look at positions 1-5
  const top5 = news.slice(0, 5);

  // Find our position (1-indexed), null if not present
  const ourIndex = top5.findIndex((a) => isOurPublisher(a.publisher));
  const ourPosition = ourIndex >= 0 ? ourIndex + 1 : null;

  return {
    top_publishers: top5.map((a, i) => ({
      position: i + 1,
      publisher: a.publisher || "Unknown",
      title: a.title || "",
    })),
    our_position: ourPosition,
    is_opportunity: ourPosition === null,
  };
}

// --- Scan Logic ---

async function runScan(runId: number, env: Env): Promise<void> {
  const db = env.DB;

  await db
    .prepare("UPDATE runs SET status = ? WHERE id = ?")
    .bind("running", runId)
    .run();

  try {
    // Fetch high-value tickers via service binding to Yahoo Reporting Worker
    const tickers = await fetchHighValueTickers(env);

    await db
      .prepare("UPDATE runs SET tickers_total = ? WHERE id = ?")
      .bind(tickers.length, runId)
      .run();

    let opportunitiesFound = 0;
    let tickersChecked = 0;

    for (const tickerData of tickers) {
      try {
        const result = await checkYahooFinance(tickerData.ticker);

        if (result.is_opportunity) opportunitiesFound++;
        tickersChecked++;

        // Store result immediately (so dashboard shows progress)
        await db
          .prepare(
            `INSERT INTO results (run_id, ticker, median_views, our_position, top_publishers, is_opportunity, checked_at)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
          )
          .bind(
            runId,
            tickerData.ticker,
            tickerData.median_views_per_article,
            result.our_position,
            JSON.stringify(result.top_publishers),
            result.is_opportunity ? 1 : 0
          )
          .run();

        // Update run progress
        await db
          .prepare(
            "UPDATE runs SET tickers_checked = ?, opportunities_found = ? WHERE id = ?"
          )
          .bind(tickersChecked, opportunitiesFound, runId)
          .run();

        // Random delay between requests (2-4 seconds)
        await sleep(2000, 4000);

        // Longer pause every 20 tickers to avoid detection
        if (tickersChecked % 20 === 0) {
          await sleep(5000, 8000);
        }
      } catch (err) {
        console.error(`Error checking ${tickerData.ticker}:`, err);
        tickersChecked++;
        // Update progress even on error so we don't get stuck
        await db
          .prepare(
            "UPDATE runs SET tickers_checked = ? WHERE id = ?"
          )
          .bind(tickersChecked, runId)
          .run();
        // Small delay before continuing
        await sleep(1000, 2000);
      }
    }

    await db
      .prepare(
        `UPDATE runs SET status = 'completed', completed_at = datetime('now'),
         tickers_checked = ?, opportunities_found = ? WHERE id = ?`
      )
      .bind(tickersChecked, opportunitiesFound, runId)
      .run();
  } catch (err) {
    console.error("Scan failed:", err);
    await db
      .prepare("UPDATE runs SET status = 'failed', error = ? WHERE id = ?")
      .bind(String(err), runId)
      .run();
  }
}

// --- Dashboard HTML ---

function renderDashboard(
  run: any | null,
  results: any[],
  pastRuns: any[]
): string {
  const statusColor =
    run?.status === "completed"
      ? "#30d158"
      : run?.status === "running"
        ? "#ff9f0a"
        : run?.status === "failed"
          ? "#ff453a"
          : "#8e8e93";

  const progressPct =
    run && run.tickers_total > 0
      ? Math.round((run.tickers_checked / run.tickers_total) * 100)
      : 0;

  // Split results into opportunities and non-opportunities
  const opportunities = results.filter((r: any) => r.is_opportunity);
  const covered = results.filter((r: any) => !r.is_opportunity);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Yahoo Opportunities</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #000; color: #f5f5f7;
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif;
      padding: 24px; max-width: 1200px; margin: 0 auto;
    }
    h1 { font-size: 28px; font-weight: 600; margin-bottom: 8px; }
    .subtitle { color: #8e8e93; font-size: 14px; margin-bottom: 24px; }
    .card {
      background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px; padding: 20px; margin-bottom: 16px;
    }
    .status-bar {
      display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
    }
    .status-dot {
      width: 10px; height: 10px; border-radius: 50%;
      display: inline-block; margin-right: 6px;
    }
    .btn {
      background: #0071e3; color: #fff; border: none; padding: 10px 20px;
      border-radius: 8px; font-size: 14px; cursor: pointer; font-weight: 500;
    }
    .btn:hover { background: #0077ed; }
    .btn:disabled { background: #333; color: #666; cursor: not-allowed; }
    .progress-bar {
      width: 200px; height: 6px; background: #333; border-radius: 3px; overflow: hidden;
    }
    .progress-fill {
      height: 100%; background: #0071e3; border-radius: 3px;
      transition: width 0.3s ease;
    }
    .stats { display: flex; gap: 24px; margin: 16px 0; flex-wrap: wrap; }
    .stat { text-align: center; }
    .stat-value { font-size: 32px; font-weight: 700; }
    .stat-label { font-size: 12px; color: #8e8e93; margin-top: 4px; }
    .stat-value.opportunity { color: #ff9f0a; }
    .stat-value.covered { color: #30d158; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th {
      text-align: left; padding: 10px 12px; color: #8e8e93; font-weight: 500;
      border-bottom: 1px solid rgba(255,255,255,0.1); font-size: 11px;
      text-transform: uppercase; letter-spacing: 0.5px;
    }
    td { padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.05); }
    tr:hover td { background: rgba(255,255,255,0.03); }
    .ticker {
      font-weight: 600; color: #0a84ff; font-family: 'SF Mono', monospace;
    }
    .publisher-list { font-size: 12px; color: #8e8e93; line-height: 1.6; }
    .publisher-list .us { color: #30d158; font-weight: 600; }
    .views { font-family: 'SF Mono', monospace; color: #f5f5f7; }
    .section-title {
      font-size: 18px; font-weight: 600; margin: 24px 0 12px;
    }
    .past-runs { font-size: 12px; color: #8e8e93; }
    .past-runs a { color: #0a84ff; text-decoration: none; }
    .empty { color: #8e8e93; text-align: center; padding: 40px; }
    .copy-btn {
      background: rgba(255,255,255,0.08); color: #0a84ff; border: 1px solid rgba(255,255,255,0.15);
      padding: 4px 10px; border-radius: 6px; font-size: 11px; cursor: pointer;
      white-space: nowrap; transition: background 0.2s;
    }
    .copy-btn:hover { background: rgba(255,255,255,0.15); }
    .copy-btn.copied { background: rgba(48,209,88,0.2); color: #30d158; border-color: #30d158; }
    .bulk-copy-btn {
      background: #ff9f0a; color: #000; border: none; padding: 10px 20px;
      border-radius: 8px; font-size: 14px; cursor: pointer; font-weight: 600;
    }
    .bulk-copy-btn:hover { background: #ffb340; }
    .bulk-copy-btn.copied { background: #30d158; }
  </style>
</head>
<body>
  <h1>Yahoo Opportunities</h1>
  <p class="subtitle">Publishing opportunities for 247wallstreet.com on Yahoo Finance</p>

  <div class="card">
    <div class="status-bar">
      <div>
        <span class="status-dot" style="background:${statusColor}"></span>
        <strong>${run ? run.status.charAt(0).toUpperCase() + run.status.slice(1) : "No scans yet"}</strong>
        ${run?.run_date ? ` &mdash; ${run.run_date}` : ""}
      </div>
      ${
        run?.status === "running"
          ? `<div class="progress-bar"><div class="progress-fill" style="width:${progressPct}%"></div></div>
             <span style="font-size:12px;color:#8e8e93">${run.tickers_checked}/${run.tickers_total} tickers</span>`
          : ""
      }
      <button class="btn" id="runBtn" ${run?.status === "running" ? "disabled" : ""}>
        ${run?.status === "running" ? "Scanning..." : "Run Scan"}
      </button>
    </div>
  </div>

  ${
    results.length > 0
      ? `
  <div class="stats">
    <div class="stat">
      <div class="stat-value opportunity">${opportunities.length}</div>
      <div class="stat-label">Opportunities</div>
    </div>
    <div class="stat">
      <div class="stat-value covered">${covered.length}</div>
      <div class="stat-label">Already Covered</div>
    </div>
    <div class="stat">
      <div class="stat-value">${results.length}</div>
      <div class="stat-label">Tickers Checked</div>
    </div>
  </div>`
      : ""
  }

  ${
    opportunities.length > 0
      ? `
  <div style="display:flex;align-items:center;gap:16px;margin:24px 0 12px;flex-wrap:wrap">
    <div class="section-title" style="color:#ff9f0a;margin:0">Opportunities (Not in Top 5)</div>
    <button class="bulk-copy-btn" onclick="copyBulk(this)">Copy First 10 for JCVC</button>
  </div>
  <div class="card" style="padding:0;overflow-x:auto">
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Ticker</th>
          <th>Median Views</th>
          <th>Top 5 Publishers on Yahoo</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${opportunities
          .map(
            (r: any, i: number) => `
        <tr>
          <td style="color:#8e8e93">${i + 1}</td>
          <td><span class="ticker">${r.ticker}</span></td>
          <td class="views">${Number(r.median_views).toLocaleString()}</td>
          <td class="publisher-list">${formatPublishers(r.top_publishers)}</td>
          <td><button class="copy-btn" onclick="copySingle(this, '${r.ticker}')">Copy for JCVC</button></td>
        </tr>`
          )
          .join("")}
      </tbody>
    </table>
  </div>`
      : results.length > 0
        ? '<div class="card empty">No opportunities found. You\'re in the top 5 for all checked tickers.</div>'
        : ""
  }

  ${
    covered.length > 0
      ? `
  <div class="section-title" style="color:#30d158">Already Covered (In Top 5)</div>
  <div class="card" style="padding:0;overflow-x:auto">
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Ticker</th>
          <th>Our Position</th>
          <th>Median Views</th>
          <th>Top 5 Publishers</th>
        </tr>
      </thead>
      <tbody>
        ${covered
          .map(
            (r: any, i: number) => `
        <tr>
          <td style="color:#8e8e93">${i + 1}</td>
          <td><span class="ticker">${r.ticker}</span></td>
          <td style="color:#30d158;font-weight:600">#${r.our_position}</td>
          <td class="views">${Number(r.median_views).toLocaleString()}</td>
          <td class="publisher-list">${formatPublishers(r.top_publishers)}</td>
        </tr>`
          )
          .join("")}
      </tbody>
    </table>
  </div>`
      : ""
  }

  ${
    pastRuns.length > 1
      ? `
  <div class="section-title">Past Scans</div>
  <div class="card past-runs">
    ${pastRuns
      .map(
        (r: any) =>
          `<div style="padding:4px 0">
        <a href="/?run=${r.id}">${r.run_date}</a>
        &mdash; ${r.opportunities_found} opportunities / ${r.tickers_checked} tickers
        (${r.status})
      </div>`
      )
      .join("")}
  </div>`
      : ""
  }

  <script>
    // Run scan button
    document.getElementById('runBtn').addEventListener('click', async function() {
      this.disabled = true;
      this.textContent = 'Starting...';
      try {
        const res = await fetch('/api/run', { method: 'POST' });
        const data = await res.json();
        if (data.run_id) {
          pollStatus();
        }
      } catch (err) {
        alert('Failed to start scan');
        this.disabled = false;
        this.textContent = 'Run Scan';
      }
    });

    // Copy prompt for a single ticker
    function copySingle(btn, ticker) {
      const prompt = 'I want to publish an article about ' + ticker + ' for now using JP Voice. Select the most appropriate series for it. Select one or two, but no more than that, relevant tickers to add to the story.';
      navigator.clipboard.writeText(prompt).then(() => {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy for JCVC'; btn.classList.remove('copied'); }, 2000);
      });
    }

    // Copy prompt for first 10 opportunities
    function copyBulk(btn) {
      const tickers = ${JSON.stringify(opportunities.slice(0, 10).map((r: any) => r.ticker))};
      const tickerList = tickers.map((t, i) => (i + 1) + '. ' + t).join('\\n');
      const prompt = 'Make an article about each one of the below tickers using JP Voice. Select the most appropriate series for each. Select one or two, but no more than that, relevant tickers to add to each story.\\n\\n' + tickerList;
      navigator.clipboard.writeText(prompt).then(() => {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy First 10 for JCVC'; btn.classList.remove('copied'); }, 2000);
      });
    }

    // Auto-refresh if scan is running
    ${
      run?.status === "running"
        ? `
    function pollStatus() {
      setTimeout(() => location.reload(), 5000);
    }
    pollStatus();`
        : ""
    }
  </script>
</body>
</html>`;
}

// Format the top publishers JSON into readable HTML
function formatPublishers(topPublishersJson: string): string {
  try {
    const publishers = JSON.parse(topPublishersJson);
    return publishers
      .map((p: any) => {
        const isUs = isOurPublisher(p.publisher);
        const cls = isUs ? ' class="us"' : "";
        return `<span${cls}>${p.position}. ${p.publisher}</span>`;
      })
      .join("<br>");
  } catch {
    return "";
  }
}

// --- Auth (Basic auth for dashboard) ---

function checkAuth(request: Request): Response | null {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Basic ")) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Yahoo Opportunities"' },
    });
  }

  const credentials = atob(auth.slice(6));
  const [user, pass] = credentials.split(":");

  if (user !== "dog" || pass !== "dog") {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Yahoo Opportunities"' },
    });
  }

  return null;
}

// --- Main Worker ---

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check (no auth)
    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    // Auth required for everything else
    const authError = checkAuth(request);
    if (authError) return authError;

    try {
      // POST /api/run - Start a new scan
      if (url.pathname === "/api/run" && request.method === "POST") {
        // Check if a scan is already running
        const existing = await env.DB.prepare(
          "SELECT id FROM runs WHERE status = 'running' OR status = 'pending' LIMIT 1"
        ).first();

        if (existing) {
          return Response.json(
            { error: "A scan is already in progress", code: "SCAN_IN_PROGRESS" },
            { status: 409 }
          );
        }

        const today = new Date().toISOString().split("T")[0];
        const result = await env.DB.prepare(
          "INSERT INTO runs (run_date, started_at, status) VALUES (?, datetime('now'), 'pending') RETURNING id"
        )
          .bind(today)
          .first<{ id: number }>();

        return Response.json({ run_id: result!.id, status: "pending" });
      }

      // GET /api/status - Get current/latest run status
      if (url.pathname === "/api/status") {
        const runId = url.searchParams.get("run");
        let run;
        if (runId) {
          run = await env.DB.prepare("SELECT * FROM runs WHERE id = ?")
            .bind(runId)
            .first();
        } else {
          run = await env.DB.prepare(
            "SELECT * FROM runs ORDER BY id DESC LIMIT 1"
          ).first();
        }

        if (!run) {
          return Response.json({ run: null, results: [] });
        }

        const results = await env.DB.prepare(
          "SELECT * FROM results WHERE run_id = ? ORDER BY is_opportunity DESC, median_views DESC"
        )
          .bind(run.id)
          .all();

        return Response.json({ run, results: results.results });
      }

      // GET / - Dashboard
      if (url.pathname === "/" || url.pathname === "/dashboard") {
        const runId = url.searchParams.get("run");
        let run;
        if (runId) {
          run = await env.DB.prepare("SELECT * FROM runs WHERE id = ?")
            .bind(runId)
            .first();
        } else {
          run = await env.DB.prepare(
            "SELECT * FROM runs ORDER BY id DESC LIMIT 1"
          ).first();
        }

        let results: any[] = [];
        if (run) {
          const res = await env.DB.prepare(
            "SELECT * FROM results WHERE run_id = ? ORDER BY is_opportunity DESC, median_views DESC"
          )
            .bind(run.id)
            .all();
          results = res.results || [];
        }

        // Get past runs for navigation
        const pastRunsRes = await env.DB.prepare(
          "SELECT id, run_date, status, tickers_checked, opportunities_found FROM runs ORDER BY id DESC LIMIT 10"
        ).all();

        const html = renderDashboard(run, results, pastRunsRes.results || []);
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return Response.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
    } catch (err) {
      console.error("Handler failed:", err);
      return Response.json(
        { error: "Internal error", code: "INTERNAL_ERROR" },
        { status: 500 }
      );
    }
  },

  // Cron trigger: picks up pending scans and runs them
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Find a pending scan
    const pendingRun = await env.DB.prepare(
      "SELECT id FROM runs WHERE status = 'pending' ORDER BY id ASC LIMIT 1"
    ).first<{ id: number }>();

    if (!pendingRun) {
      return; // Nothing to do
    }

    // Run the scan (this can take ~10 minutes, within cron's 15-min limit)
    await runScan(pendingRun.id, env);
  },
};
