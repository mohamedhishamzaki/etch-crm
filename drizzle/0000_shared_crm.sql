CREATE TABLE shared_crm (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL CHECK (revision > 0),
  records TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
