-- Atomic daily request budgets per upstream connection and exact Gemini model.
-- quota_day is the America/Los_Angeles calendar day, including DST transitions.
CREATE TABLE IF NOT EXISTS gemini_daily_request_counts (
  connection_id TEXT NOT NULL,
  model TEXT NOT NULL,
  quota_day TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, model, quota_day),
  FOREIGN KEY (connection_id) REFERENCES provider_connections(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_gemini_daily_request_counts_day
  ON gemini_daily_request_counts (quota_day);
