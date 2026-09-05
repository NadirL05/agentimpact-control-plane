-- Synthetic V1 contract fixture based on Nadir's schema evidence, no production data.
CREATE TABLE agent_actions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text DEFAULT 'proposed',
 profile text, intent text, targets jsonb, payload jsonb DEFAULT '{}', payload_hash text,
 risk_level text, dry_run boolean DEFAULT true, approval_expires_at timestamptz,
 approved_at timestamptz, approved_by text, executed_at timestamptz, error_message text,
 created_at timestamptz DEFAULT now()
);
CREATE TABLE agent_approvals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), action_id uuid REFERENCES agent_actions(id),
 approver text, decision text CHECK (decision IN ('approved','rejected')), reason text,
 payload_hash text, expires_at timestamptz, decided_at timestamptz DEFAULT now(),
 UNIQUE(action_id, payload_hash)
);
CREATE TABLE agent_missions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), action_id uuid NOT NULL REFERENCES agent_actions(id),
 target_agent text NOT NULL, source_type text NOT NULL, source_id text NOT NULL, source_url text,
 title text NOT NULL, payload jsonb NOT NULL DEFAULT '{}', priority text NOT NULL DEFAULT 'medium',
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed','failed','rejected')),
 dry_run boolean NOT NULL DEFAULT true, requires_human_validation boolean NOT NULL DEFAULT true,
 result jsonb, processed_at timestamptz, error_message text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(source_type,source_id)
);
