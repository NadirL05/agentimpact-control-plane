# AgentImpact – état actuel (J0)

## Serveur

- Hôte : srv1880033 (VPS)
- Utilisateur API : agentimpact
- Services Docker :
  - agentimpact-api (Node, Hono, port 3000, PostgreSQL)
  - agentimpact-db (PostgreSQL 16, base agentimpact)

## Base de données

- Base : agentimpact
- Tables clés :
  - agent_actions
  - agent_audit_events
  - agent_approvals
  - agent_corrections

## API Control Plane

- GET /health
- GET /actions
- POST /actions
- PATCH /actions/:id/approve
- PATCH /actions/:id/reject

## Dashboard

- Projet Vite React dans /opt/agentimpact/dashboard
- Dev server : http://localhost:8081
- Fonctionnalités :
  - Liste des actions
  - Approve / Reject
  - Audit en base

## Connecteurs disponibles (globaux)

- Google Calendar
- Google Drive
- Outlook
- Vercel
- Supabase
- GitHub
- Jira
- Neon
- Hugging Face
- Finance
