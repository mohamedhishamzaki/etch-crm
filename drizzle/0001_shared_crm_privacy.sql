CREATE TABLE shared_crm_privacy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  contacts_visible INTEGER NOT NULL CHECK (contacts_visible IN (0, 1))
);
