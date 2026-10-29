-- AI context digest uploaded by the members' phones (scoreboard, last ~2 months of sessions,
-- wellness, last training dates). AI runs read it instead of the whole history (CPU budget).
ALTER TABLE challenges ADD COLUMN ai_digest TEXT;
