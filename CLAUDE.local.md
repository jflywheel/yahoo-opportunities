# Yahoo Opportunities

## Context: FWP (Flywheel Publishing)
- Uses FWP_ prefixed secrets from Cloudflare Secrets Store
- GitHub: github.com/jflywheel (personal GitHub)
- Cloudflare account: "Helms Deep"
- Deployed: https://yahoo-opportunities.helmsdeep.workers.dev/
- Auth: Basic auth (dog:dog)

## What this project does
Daily opportunity finder that combines data from two other FWP projects:
1. **Yahoo Reporting Worker** (yahoo-report-worker.helmsdeep.workers.dev) - provides high-value ticker data (tickers with high median article views) via service binding
2. **Yahoo Finance Search API** (query2.finance.yahoo.com/v1/finance/search) - checked directly for current publisher positions (1-5)

Workflow: Get top 200 tickers by median views, check Yahoo Finance for each, flag tickers where 247wallstreet.com is NOT in positions 1-5 as publishing opportunities.

## Architecture
- Service binding (YAHOO_REPORTING) connects to yahoo-report-worker (no public URL fetch needed)
- FWP_YAHOO_REPORTING_API_KEY in Secrets Store authenticates the service-to-service call
- Cron runs every minute, picks up pending scan runs
- Full scan takes ~10 minutes (200 tickers, 2-4s delays, longer pauses every 20)
- Stuck runs auto-expire after 20 minutes
- User-Agent rotation (10 strings) to avoid Yahoo rate limiting
- D1 stores runs and per-ticker results

## Dashboard features
- "Run Scan" button to trigger a new scan
- Real-time progress (auto-refreshes every 5s while running)
- Opportunities table with "Copy for JCVC" per-row buttons
- "Copy First 10 for JCVC" bulk button (generates prompt for content creation system)
- Already Covered table showing tickers where we're in top 5
- Past Scans navigation

## JCVC copy prompts
- Single: "I want to publish an article about {TICKER} for now using JP Voice. Select the most appropriate series for it. Select one or two, but no more than that, relevant tickers to add to the story."
- Bulk (first 10): Same instructions applied to a numbered list of tickers

## Related projects
- Yahoo Reporting: /Users/jp/Desktop/yahoo-reporting/
- Ticker Pulse: /Users/jp/github/TickerPulse/ (endpoints/techniques borrowed, not called directly)

## Key files
- src/index.ts - Single-file Worker with crawler, dashboard, and scan logic
- schema.sql - D1 schema (runs + results tables)
- wrangler.toml - Bindings: D1, Secrets Store, Service Binding

## Future planned feature
Generate more detailed copy-paste article payloads from opportunity list for the article generator.
