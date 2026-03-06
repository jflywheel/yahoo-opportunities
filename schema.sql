-- Tracks each scan run
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  tickers_total INTEGER DEFAULT 0,
  tickers_checked INTEGER DEFAULT 0,
  opportunities_found INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT
);

-- Individual ticker results per run
CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  median_views INTEGER NOT NULL,
  our_position INTEGER,
  top_publishers TEXT NOT NULL,
  is_opportunity INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE INDEX IF NOT EXISTS idx_results_run_id ON results(run_id);
CREATE INDEX IF NOT EXISTS idx_results_ticker ON results(ticker);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_date ON runs(run_date);
