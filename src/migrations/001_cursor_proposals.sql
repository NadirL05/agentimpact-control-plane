-- Propositions Cursor / hermesctl — isolées du bus missions jusqu'à promotion admin.

CREATE TABLE IF NOT EXISTS cursor_proposals (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  proposed_by_uid     INTEGER NOT NULL,
  proposed_by         TEXT NOT NULL DEFAULT 'agentimpact-runner',
  target_agent        TEXT NOT NULL CHECK (target_agent IN ('dev-senior')),
  title               TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  instruction         TEXT NOT NULL CHECK (char_length(instruction) BETWEEN 10 AND 8000),
  source_url          TEXT CHECK (source_url IS NULL OR source_url ~ '^https://'),
  priority            TEXT NOT NULL DEFAULT 'normal'
                      CHECK (priority IN ('low', 'normal', 'high')),
  status              TEXT NOT NULL DEFAULT 'awaiting_nadir_review'
                      CHECK (status IN ('awaiting_nadir_review', 'promoted', 'rejected', 'expired')),
  reviewed_at         TIMESTAMPTZ,
  reviewed_by         TEXT,
  promoted_action_id  UUID REFERENCES agent_actions(id),
  promoted_mission_id UUID REFERENCES agent_missions(id),
  CONSTRAINT no_mission_without_review
    CHECK (promoted_mission_id IS NULL OR reviewed_by IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_cursor_proposals_status
  ON cursor_proposals (status, created_at DESC);
