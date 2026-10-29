-- Squad: shared challenges. Everything that happens in a challenge is an event with a
-- per-challenge sequence number; clients sync with "give me everything after seq N".

CREATE TABLE IF NOT EXISTS challenges (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  invite      TEXT NOT NULL UNIQUE,
  owner       TEXT NOT NULL,              -- member id of the creator (manages settings and the AI)
  starts      TEXT NOT NULL,              -- YYYY-MM-DD
  ends        TEXT,                       -- YYYY-MM-DD or NULL (open-ended)
  rules       TEXT NOT NULL DEFAULT '{}', -- JSON: days_per_week, roast level, recap hour…
  tz_offset   INTEGER NOT NULL DEFAULT 0, -- minutes east of UTC (daily recap, "today")
  seq         INTEGER NOT NULL DEFAULT 0, -- last issued sequence number
  ai_config   TEXT,                       -- JSON incl. the API key — never sent to clients
  ai_state    TEXT NOT NULL DEFAULT '{}', -- JSON, only written while holding ai_lock
  ai_lock     INTEGER NOT NULL DEFAULT 0, -- epoch ms until which one AI run owns the challenge
  ai_month    TEXT,                       -- YYYY-MM of ai_spend
  ai_spend    REAL NOT NULL DEFAULT 0,    -- estimated USD this month (spend cap)
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id            TEXT PRIMARY KEY,
  challenge_id  TEXT NOT NULL,
  name          TEXT NOT NULL,
  color         TEXT NOT NULL,
  token_hash    TEXT NOT NULL,            -- SHA-256 of the member's secret token ('' after leaving)
  sports        TEXT NOT NULL DEFAULT '[]',
  baseline      TEXT NOT NULL DEFAULT '{}', -- own numbers before the challenge (relative scoring)
  joined_at     TEXT NOT NULL,
  last_seen     TEXT
);
CREATE INDEX IF NOT EXISTS members_by_challenge ON members (challenge_id);
CREATE INDEX IF NOT EXISTS members_by_token ON members (token_hash);

CREATE TABLE IF NOT EXISTS events (
  challenge_id  TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  id            TEXT NOT NULL,            -- client-generated (idempotent retries from the outbox)
  kind          TEXT NOT NULL,            -- msg | activity | comment | reaction | delete | system
  author        TEXT NOT NULL,            -- member id, or 'ai'
  ref           TEXT,                     -- target event id (comment/reaction/delete/reply)
  body          TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  PRIMARY KEY (challenge_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS events_by_id ON events (challenge_id, id);
