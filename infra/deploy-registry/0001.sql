CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL UNIQUE,
  repository TEXT NOT NULL UNIQUE,
  branch TEXT NOT NULL,
  workflow TEXT NOT NULL,
  origin TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  active_release TEXT,
  run_number INTEGER NOT NULL DEFAULT 0,
  run_attempt INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS releases (
  project_id TEXT NOT NULL REFERENCES projects(id),
  release TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  run_number INTEGER NOT NULL,
  run_attempt INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, run_number, run_attempt),
  UNIQUE (project_id, release)
);
