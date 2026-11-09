-- Progress photos a member chose to share with his challenge (3.11).
-- The image is stored as base64 JPEG text and passed through untouched (free-plan CPU);
-- a 'photo' event in the log announces it. Leaving the challenge deletes his photos.
CREATE TABLE IF NOT EXISTS photos (
  id            TEXT PRIMARY KEY,
  challenge_id  TEXT NOT NULL,
  author        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  size          INTEGER NOT NULL,
  data          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS photos_by_challenge ON photos (challenge_id, author);
