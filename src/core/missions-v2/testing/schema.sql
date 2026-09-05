-- Synthetic V1 contract fixture based on Nadir's schema evidence, no production data.
CREATE TABLE agent_actions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text DEFAULT 'proposed', payload_hash text, executed_at timestamptz, error_message text);
CREATE TABLE agent_approvals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), action_id uuid REFERENCES agent_actions(id));
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
