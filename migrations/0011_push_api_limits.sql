CREATE TABLE push_api_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at TEXT NOT NULL);
CREATE INDEX push_api_limits_expiry ON push_api_limits(expires_at);
CREATE INDEX push_batch_created ON push_batches(created_at);
