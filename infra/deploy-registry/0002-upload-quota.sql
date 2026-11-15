CREATE TABLE IF NOT EXISTS upload_leases (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  lease_id TEXT NOT NULL,
  started_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS upload_usage (
  project_id TEXT NOT NULL REFERENCES projects(id),
  utc_day TEXT NOT NULL,
  uploads INTEGER NOT NULL,
  PRIMARY KEY (project_id, utc_day)
);
