CREATE TABLE push_devices (
  endpoint TEXT PRIMARY KEY,
  subscription TEXT NOT NULL,
  language TEXT NOT NULL,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE push_deliveries (
  endpoint TEXT NOT NULL,
  reminder_id TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  sent_at INTEGER,
  PRIMARY KEY (endpoint, reminder_id)
);

