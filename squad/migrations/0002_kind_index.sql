-- Lets the AI context and the cheap checks read one kind of event (activities, wellness,
-- messages…) without scanning the whole challenge — fewer D1 rows read on the free plan.
CREATE INDEX IF NOT EXISTS events_by_kind ON events (challenge_id, kind, seq);
