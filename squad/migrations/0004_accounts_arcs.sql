-- Accounts (username sign-in, the friend's app on several devices) and squad arcs.
-- The server never sees a password or the person's data: the app derives an auth key and an
-- encryption key from the password; only SHA-256(auth key) and the encrypted vault are stored.
CREATE TABLE IF NOT EXISTS accounts (
  username       TEXT PRIMARY KEY,
  auth_hash      TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  failed         INTEGER NOT NULL DEFAULT 0,  -- wrong sign-ins in a row
  locked_until   INTEGER NOT NULL DEFAULT 0,  -- epoch ms
  vault_version  INTEGER NOT NULL DEFAULT 0,
  vault_parts    INTEGER NOT NULL DEFAULT 0,
  vault_size     INTEGER NOT NULL DEFAULT 0,
  vault_at       TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  username    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  device      TEXT
);
CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions (username);
CREATE TABLE IF NOT EXISTS vault_parts (
  username  TEXT NOT NULL,
  version   INTEGER NOT NULL,
  part      INTEGER NOT NULL,
  data      BLOB NOT NULL,
  PRIMARY KEY (username, version, part)
);

-- Arcs: a squad's seasons. arc 0 = before the first "Start new arc".
ALTER TABLE challenges ADD COLUMN arc INTEGER NOT NULL DEFAULT 0;
ALTER TABLE challenges ADD COLUMN arc_seq INTEGER NOT NULL DEFAULT 0;   -- event seq where the arc began
ALTER TABLE challenges ADD COLUMN arc_vote TEXT;                         -- JSON { arc, by: [member ids], at }
ALTER TABLE challenges ADD COLUMN arcs TEXT NOT NULL DEFAULT '[]';       -- JSON [{ n, from, to, seq_from, seq_to }]
