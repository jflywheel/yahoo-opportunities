# Yahoo Opportunities

## Context: FWP (Flywheel Publishing)
- Uses FWP_ prefixed secrets from Cloudflare Secrets Store
- GitHub: github.com/jflywheel (personal GitHub)
- Cloudflare account: "Helms Deep"

## What this project does
Daily opportunity finder that combines data from two other FWP projects:
1. **Yahoo Reporting Worker** (yahoo-report-worker.helmsdeep.workers.dev) - provides high-value ticker data (tickers with high median article views)
2. **Yahoo Finance Search API** (query2.finance.yahoo.com) - checked directly for current publisher positions

Workflow: Get top 200 tickers by median views, check Yahoo Finance for each, flag tickers where 247wallstreet.com is NOT in positions 1-5 as publishing opportunities.

## Related projects
- Yahoo Reporting: /Users/jp/Desktop/yahoo-reporting/
- Ticker Pulse: /Users/jp/github/TickerPulse/

## Future planned feature
Generate copy-paste article payloads from opportunity list (not built yet).
