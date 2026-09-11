import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { digest, MissionError, projects } from '../missions-v2/model.js';
import type { MissionStore } from '../missions-v2/store.js';
import { configuredSupersetRpcBackend } from '../missions-v2/superset/runtime.js';
import type { OperatorRequest, OperatorResponse } from './contract.js';

const explanations: Record<string, string> = {
  approval_required: 'Cette operation est preparee, mais une approbation explicite liee au hash exact est requise.',
  publisher_disabled: 'La publication est verrouillee tant que le service Publisher et son identite GitHub App ne sont pas actives.',
  publisher_credential_not_configured: 'La GitHub App Publisher dediee doit encore etre creee et installee.',
  deploy_disabled: 'Le deploiement est verrouille par la politique de production.',
  execution_disabled: 'L execution fournisseur reste desactivee; aucune consommation de quota n a eu lieu.',
  mission_not_found: 'Mission introuvable dans l organisation AgentImpact.',
  approval_invalid: 'L approbation ne correspond pas exactement a cette operation, a expire ou a deja ete consommee.',
  awaiting_reconciliation: 'L arret n est pas prouve; le workspace et le lease restent en quarantaine.',
  quota_unknown_fail_closed: 'Le quota fournisseur est inconnu ou perime; le lancement est refuse par securite.',
  human_confirmation_channel_required: 'Une approbation doit venir du canal admin humain separe; OpenJarvis ne peut pas approuver sa propre demande.',
  attempt_not_current: 'Cette tentative n est plus la generation active de la mission; aucun worker courant n a ete arrete.',
  project_forbidden: 'Ce projet ne fait pas partie de l allowlist de l organisation.',
  scheduler_owned_start_required: 'Le lancement appartient au scheduler durable du Control Plane; l ancien chemin Jarvis ne peut pas demarrer un fournisseur.',
};

function response(request: OperatorRequest, init: Omit<OperatorResponse, 'request_id'|'operation'|'explanation'> & {explanation?: string}): OperatorResponse {
  return {
    request_id: request.request_id,
    operation: request.operation,
    ...init,
    explanation: init.explanation ?? (init.error_code ? explanations[init.error_code] : undefined)
      ?? (init.ok ? 'Operation AgentImpact terminee.' : 'Operation bloquee par la politique AgentImpact.'),
  };
}

type Action = { id:string; profile:string; intent:string; payload_hash:string; status:string;
  approval_expires_at:string|null; payload:unknown; created_at:string };

export class OperatorService {
  constructor(
    private readonly pool: Pool,
    private readonly store: MissionStore,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async claimRequest(request: OperatorRequest): Promise<boolean> {
    const result=await this.pool.query<{claimed:boolean}>(`WITH pruned AS (
        DELETE FROM operator_request_nonces WHERE expires_at<=clock_timestamp()
      ), claimed AS (
        INSERT INTO operator_request_nonces(request_id,organization_id,operation,requested_at,expires_at)
        VALUES($1,$2,$3,$4::timestamptz,$4::timestamptz+interval '2 minutes')
        ON CONFLICT (request_id) DO NOTHING RETURNING request_id
      ) SELECT EXISTS(SELECT 1 FROM claimed) AS claimed`,
      [request.request_id,request.organization_id,request.operation,request.requested_at]);
    return result.rows[0]?.claimed===true;
  }

  async handle(request: OperatorRequest, actor = 'nadir:openjarvis'): Promise<OperatorResponse> {
    switch (request.operation) {
      case 'agentimpact.health': return this.health(request);
      case 'agentimpact.status': return this.status(request);
      case 'agentimpact.missions.list': return this.missionsList(request);
      case 'agentimpact.missions.inspect': return this.missionInspect(request);
      case 'agentimpact.missions.create': return this.missionAction(request, actor, 'mission.create');
      case 'agentimpact.missions.cancel': return this.missionAction(request, actor, 'mission.cancel');
      case 'agentimpact.missions.events': return this.events(request);
      case 'agentimpact.agent.status': return this.agentStatus(request);
      case 'agentimpact.agent.start': return this.agentStart(request);
      case 'agentimpact.agent.stop': return this.agentStop(request, actor);
      case 'agentimpact.workspace.inspect': return this.workspace(request);
      case 'agentimpact.tests.run': return this.testsRun(request);
      case 'agentimpact.tests.status': return this.tests(request);
      case 'agentimpact.diff.read': return this.diff(request);
      case 'agentimpact.approvals.list': return this.approvalsList(request);
      case 'agentimpact.approvals.inspect': return this.approvalInspect(request);
      case 'agentimpact.approvals.approve': return this.approvalDecision(request, actor);
      case 'agentimpact.publisher.prepare': return this.publisherPrepare(request);
      case 'agentimpact.publisher.publish': return this.publisherPublish(request);
      case 'agentimpact.deploy.prepare': return this.deployPrepare(request);
      case 'agentimpact.deploy.execute': return this.deployExecute(request);
    }
  }

  private async health(request: OperatorRequest): Promise<OperatorResponse> {
    await this.pool.query('SELECT 1');
    const backend = configuredSupersetRpcBackend(this.env);
    const superset = backend ? await backend.health() : {ok:false, detail:'rpc_not_configured'};
    return response(request, {ok:Boolean(superset.ok), status:superset.ok?'completed':'failed',
      data:{control_plane:'ok',database:'ok',superset},
      ...(superset.ok ? {} : {error_code:'superset_unhealthy'}),
      explanation:superset.ok ? 'Control Plane, PostgreSQL et le pont Superset repondent.' : 'Control Plane et PostgreSQL repondent, mais Superset est degrade.',
    });
  }

  private async status(request: OperatorRequest): Promise<OperatorResponse> {
    const requestedProject = typeof request.parameters.project === 'string' ? request.parameters.project : undefined;
    const allowedProjects = [...projects(this.env)];
    if(requestedProject&&!allowedProjects.includes(requestedProject)) throw new MissionError('project_forbidden',403);
    const selected = requestedProject ? [requestedProject] : allowedProjects;
    const [missions, attempts, approvals, budgets, quota] = await Promise.all([
      this.pool.query(`SELECT lifecycle_state,count(*)::int AS count FROM agent_missions
        WHERE orchestration_version=2 AND project=ANY($1::text[]) GROUP BY lifecycle_state ORDER BY lifecycle_state`, [selected]),
      this.pool.query(`SELECT a.status,count(*)::int AS count FROM mission_attempts a JOIN agent_missions m ON m.id=a.mission_id
        WHERE m.project=ANY($1::text[]) GROUP BY a.status ORDER BY a.status`, [selected]),
      this.pool.query(`SELECT count(*)::int AS count FROM agent_actions WHERE status IN ('proposed','approval_requested')
        AND (approval_expires_at IS NULL OR approval_expires_at>clock_timestamp())`),
      this.pool.query(`SELECT status,count(*)::int AS count,COALESCE(sum(reserved_amount),0)::text AS reserved,
        COALESCE(sum(consumed_amount),0)::text AS consumed FROM budget_reservations GROUP BY status ORDER BY status`),
      this.pool.query(`SELECT worker_type,quota_state,source,observed_at,expires_at,
        expires_at>clock_timestamp() AS fresh FROM jarvis_agent_quota_state ORDER BY worker_type`),
    ]);
    const backend = configuredSupersetRpcBackend(this.env);
    const superset = backend ? await backend.health() : {ok:false, detail:'rpc_not_configured'};
    return response(request, {ok:true,status:'completed',data:{
      organization_id:this.env.AGENTIMPACT_ORGANIZATION_ID ?? 'org-agentimpact', projects:selected,
      missions:missions.rows, attempts:attempts.rows, approvals_pending:approvals.rows[0]?.count ?? 0,
      budgets:budgets.rows, quota:quota.rows, superset,
      execution:{business_enabled:this.env.AGENTIMPACT_V2_EXECUTION_ENABLED==='1',provider_armed:this.env.AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED==='1'},
      publisher:{enabled:this.env.AGENTIMPACT_PUBLISHER_ENABLED==='1',credential_configured:Boolean(this.env.GITHUB_APP_ID)},
      deploy:{enabled:this.env.AGENTIMPACT_DEPLOY_ENABLED==='1'},
    },explanation:'Vue operateur consolidee sans acces SSH ni acces direct a PostgreSQL.'});
  }

  private async missionsList(request: OperatorRequest): Promise<OperatorResponse> {
    const project = typeof request.parameters.project === 'string' ? request.parameters.project : [...projects(this.env)][0];
    if (!project) throw new MissionError('project_required',400);
    if(!projects(this.env).has(project)) throw new MissionError('project_forbidden',403);
    const limit = typeof request.parameters.limit === 'number' ? request.parameters.limit : 50;
    const result = await this.pool.query(`SELECT id,project,title,objective,lifecycle_state,state_version,plan_version,
      current_attempt_id,phase,blocked_reason,head_sha,base_sha,created_at,updated_at FROM agent_missions
      WHERE orchestration_version=2 AND project=$1 ORDER BY created_at DESC,id LIMIT $2`,[project,limit]);
    return response(request,{ok:true,status:'completed',data:{project,count:result.rowCount,items:result.rows}});
  }

  private async missionInspect(request: OperatorRequest): Promise<OperatorResponse> {
    const id=String(request.parameters.mission_id);
    const mission=await this.store.get(id);
    const [plan,attempts,workspace,tests] = await Promise.all([
      this.store.plan(id),
      this.pool.query(`SELECT id,attempt_number,worker_type,worker_instance_id,status,fencing_token,deadline_at,
        lease_expires_at,heartbeat_at,error_code,error_summary,stop_proof_at,reconciled_at,execution_backend,
        superset_project_id,superset_workspace_id,superset_terminal_id,branch,base_sha,head_sha
        FROM mission_attempts WHERE mission_id=$1 ORDER BY attempt_number DESC`,[id]),
      this.pool.query(`SELECT id,attempt_id,repo,branch,status,owner_worker,fencing_token,execution_backend,
        superset_workspace_id,quarantine_reason,lease_expires_at,released_at FROM worktree_leases
        WHERE mission_id=$1 ORDER BY created_at DESC`,[id]),
      this.pool.query(`SELECT a.kind,a.relative_path,a.sha256,a.size_bytes,a.created_at FROM codex_artifacts a
        JOIN mission_attempts x ON x.id=a.attempt_id WHERE x.mission_id=$1 ORDER BY a.created_at DESC`,[id]),
    ]);
    return response(request,{ok:true,status:'completed',data:{mission,plan,attempts:attempts.rows,workspaces:workspace.rows,artifacts:tests.rows}});
  }

  private async events(request: OperatorRequest): Promise<OperatorResponse> {
    const items=await this.store.events(String(request.parameters.mission_id),String(request.parameters.after??'0'));
    return response(request,{ok:true,status:'completed',data:{items}});
  }

  private async missionAction(request: OperatorRequest, actor:string, action:'mission.create'|'mission.cancel'): Promise<OperatorResponse> {
    if(action==='mission.create') {
      const p=request.parameters;
      const mission=await this.store.admit({project:String(p.project),title:String(p.title),objective:String(p.objective),
        source_type:'command',source_id:request.request_id},{principal:actor,key:`operator-create:${request.request_id}`});
      return response(request,{ok:true,status:'accepted',data:{mission_id:mission.id,lifecycle_state:mission.lifecycle_state,
        requested_worker_type:p.requested_worker_type,hermes_handoff:'queued',execution_backend:'scheduler_owned',publisher:'off'},
        explanation:'Mission enregistree par le Control Plane et placee dans la file de planification Hermes.'});
    }
    const mission=await this.store.cancel(String(request.parameters.mission_id),String(request.parameters.reason),
      {principal:actor,key:`operator-cancel:${request.request_id}`});
    return response(request,{ok:true,status:'accepted',data:{mission},
      explanation:'Annulation enregistree par le Control Plane; tout arret de worker reste soumis a reconciliation.'});
  }

  private async agentStatus(request: OperatorRequest): Promise<OperatorResponse> {
    const id=String(request.parameters.mission_id);
    await this.store.get(id);
    const result=await this.pool.query(`SELECT id AS attempt_id,attempt_number,worker_type,worker_instance_id,status,
      fencing_token,deadline_at,lease_expires_at,heartbeat_at,error_code,stop_proof_at,reconciled_at,
      provider_session_id,execution_backend,superset_workspace_id,superset_terminal_id
      FROM mission_attempts WHERE mission_id=$1 ORDER BY attempt_number DESC LIMIT 1`,[id]);
    return response(request,{ok:true,status:'completed',data:{agent:result.rows[0]??null}});
  }

  private async agentStart(request: OperatorRequest): Promise<OperatorResponse> {
    const missionId=String(request.parameters.mission_id),attemptId=String(request.parameters.attempt_id);
    await this.store.get(missionId);
    const attempt=await this.pool.query(`SELECT a.id,a.status,a.worker_type,a.fencing_token,a.workspace_id,m.current_attempt_id
      FROM mission_attempts a JOIN agent_missions m ON m.id=a.mission_id
      WHERE a.id=$1 AND a.mission_id=$2`,[attemptId,missionId]);
    if(!attempt.rows[0]) throw new MissionError('attempt_not_found',404);
    if(attempt.rows[0].current_attempt_id!==attemptId) throw new MissionError('attempt_not_current',409);
    return response(request,{ok:false,status:'blocked',error_code:'scheduler_owned_start_required',data:{
      mission_id:missionId,attempt_id:attemptId,attempt_status:attempt.rows[0].status,
      real_codex_calls:0,real_cursor_calls:0,
    }});
  }

  private async agentStop(request: OperatorRequest, actor:string): Promise<OperatorResponse> {
    const missionId=String(request.parameters.mission_id),attemptId=String(request.parameters.attempt_id);
    const found=await this.pool.query(`SELECT a.id,a.status,a.stop_proof_at,a.reconciled_at,m.current_attempt_id
      FROM mission_attempts a JOIN agent_missions m ON m.id=a.mission_id WHERE a.id=$1 AND a.mission_id=$2`,[attemptId,missionId]);
    if(!found.rows[0]) throw new MissionError('attempt_not_found',404);
    if(found.rows[0].current_attempt_id!==attemptId) throw new MissionError('attempt_not_current',409);
    const mission=await this.store.cancel(missionId,String(request.parameters.reason),
      {principal:actor,key:`operator-stop:${request.request_id}`},attemptId);
    const proven=Boolean(found.rows[0].stop_proof_at&&found.rows[0].reconciled_at);
    return response(request,{ok:true,status:'accepted',data:{mission,attempt_id:attemptId,stop_proven:proven,
      lifecycle:proven?'cancelled':'awaiting_reconciliation'},
      explanation:proven?'Arret deja prouve et reconcilie.':'Arret demande; le lease reste possede jusqu a la preuve de terminaison.'});
  }

  private async workspace(request: OperatorRequest): Promise<OperatorResponse> {
    await this.store.get(String(request.parameters.mission_id));
    const result=await this.pool.query(`SELECT w.id,w.attempt_id,w.repo,w.base_sha,w.branch,w.status,w.owner_worker,
      w.fencing_token,w.execution_backend,w.superset_workspace_id,w.quarantine_reason,w.lease_expires_at,w.released_at
      FROM worktree_leases w WHERE w.mission_id=$1 ORDER BY w.created_at DESC`,[request.parameters.mission_id]);
    return response(request,{ok:true,status:'completed',data:{items:result.rows}});
  }

  private async testsRun(request: OperatorRequest): Promise<OperatorResponse> {
    await this.store.get(String(request.parameters.mission_id));
    const found=await this.pool.query(`SELECT a.status,m.current_attempt_id FROM mission_attempts a
      JOIN agent_missions m ON m.id=a.mission_id WHERE a.id=$1 AND a.mission_id=$2`,
      [request.parameters.attempt_id,request.parameters.mission_id]);
    if(!found.rows[0]) throw new MissionError('attempt_not_found',404);
    if(found.rows[0].current_attempt_id!==request.parameters.attempt_id) throw new MissionError('attempt_not_current',409);
    return response(request,{ok:false,status:'blocked',error_code:'execution_disabled',data:{
      test_profile:request.parameters.test_profile,reason:'tests_are_scheduler_owned',provider_calls:0}});
  }

  private async tests(request: OperatorRequest): Promise<OperatorResponse> {
    await this.store.get(String(request.parameters.mission_id));
    const result=await this.pool.query(`SELECT a.attempt_id,a.kind,a.relative_path,a.sha256,a.size_bytes,a.created_at
      FROM codex_artifacts a JOIN mission_attempts x ON x.id=a.attempt_id
      WHERE x.mission_id=$1 AND a.kind IN ('test_report','validation_report') ORDER BY a.created_at DESC`,[request.parameters.mission_id]);
    return response(request,{ok:true,status:'completed',data:{items:result.rows}});
  }

  private async diff(request: OperatorRequest): Promise<OperatorResponse> {
    const id=String(request.parameters.mission_id);
    await this.store.get(id);
    const result=await this.pool.query(`SELECT superset_workspace_id,workspace_path,base_sha FROM mission_attempts
      WHERE mission_id=$1 AND execution_backend='superset' AND superset_workspace_id IS NOT NULL
      ORDER BY attempt_number DESC LIMIT 1`,[id]);
    const attempt=result.rows[0];
    if(!attempt) return response(request,{ok:true,status:'completed',data:{patch:'',files:[],note:'no_superset_attempt'}});
    const backend=configuredSupersetRpcBackend(this.env);
    if(!backend) return response(request,{ok:false,status:'failed',error_code:'superset_unavailable'});
    const data=await backend.getDiff(String(attempt.superset_workspace_id),String(attempt.workspace_path),String(attempt.base_sha));
    return response(request,{ok:true,status:'completed',data});
  }

  private async approvalsList(request: OperatorRequest): Promise<OperatorResponse> {
    const limit=typeof request.parameters.limit==='number'?request.parameters.limit:50;
    const r=await this.pool.query(`SELECT id,created_at,profile,intent,targets,payload_hash,risk_level,status,
      approval_expires_at,(approval_expires_at IS NOT NULL AND approval_expires_at<=clock_timestamp()) AS expired
      FROM agent_actions WHERE status IN ('proposed','approval_requested') ORDER BY created_at DESC LIMIT $1`,[limit]);
    return response(request,{ok:true,status:'completed',data:{count:r.rowCount,items:r.rows}});
  }

  private async approvalInspect(request: OperatorRequest): Promise<OperatorResponse> {
    const action=await this.loadAction(String(request.parameters.action_id));
    const decisions=await this.pool.query(`SELECT id,approver,decision,reason,payload_hash,decided_at,expires_at
      FROM agent_approvals WHERE action_id=$1 ORDER BY decided_at DESC`,[action.id]);
    return response(request,{ok:true,status:'completed',data:{action,decisions:decisions.rows}});
  }

  private async approvalDecision(request: OperatorRequest, actor:string): Promise<OperatorResponse> {
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      const action=(await client.query<Action>(`SELECT id,profile,intent,payload_hash,status,approval_expires_at,payload,created_at
        FROM agent_actions WHERE id=$1 FOR UPDATE`,[request.parameters.action_id])).rows[0];
      if(!action) throw new MissionError('action_not_found',404);
      const decision=String(request.parameters.decision);
      if(decision==='approved'&&actor!=='api:admin') throw new MissionError('human_confirmation_channel_required',403);
      const approver=actor==='api:admin'?'human-admin':actor;
      if(action.profile===approver) throw new MissionError('self_approval_forbidden',403);
      if(action.payload_hash!==request.parameters.payload_hash) throw new MissionError('approval_invalid',403);
      if(!['proposed','approval_requested'].includes(action.status)) throw new MissionError('approval_invalid',409);
      if(!action.approval_expires_at || Date.parse(action.approval_expires_at)<=Date.now()) throw new MissionError('approval_invalid',409);
      await client.query(`INSERT INTO agent_approvals(action_id,approver,decision,reason,payload_hash,expires_at)
        VALUES($1,$2,$3,$4,$5,$6)`,[action.id,approver,decision,request.parameters.reason??null,action.payload_hash,action.approval_expires_at]);
      await client.query(`UPDATE agent_actions SET status=$2,approved_at=clock_timestamp(),approved_by=$3 WHERE id=$1`,
        [action.id,decision,approver]);
      await client.query(`INSERT INTO agent_audit_events(action_id,event_type,actor,details)
        VALUES($1,$2,$3,$4::jsonb)`,[action.id,decision,approver,JSON.stringify({payload_hash:action.payload_hash})]);
      await client.query('COMMIT');
      return response(request,{ok:true,status:'completed',data:{action_id:action.id,decision,payload_hash:action.payload_hash},
        explanation:`Decision ${decision} enregistree pour le payload exact.`});
    } catch(error) { await client.query('ROLLBACK').catch(()=>undefined); throw error; }
    finally { client.release(); }
  }

  private async publisherPrepare(request: OperatorRequest): Promise<OperatorResponse> {
    const p=request.parameters;
    const check=await this.pool.query(`SELECT m.lifecycle_state,m.current_attempt_id,m.head_sha AS mission_head,a.status AS attempt_status,a.head_sha AS attempt_head,
      c.validation_state,c.publisher_state,
      EXISTS(SELECT 1 FROM codex_artifacts x WHERE x.attempt_id=a.id AND x.kind='diff') AS has_diff,
      EXISTS(SELECT 1 FROM codex_artifacts x WHERE x.attempt_id=a.id AND x.kind IN ('test_report','validation_report')) AS has_validation
      FROM agent_missions m JOIN mission_attempts a ON a.mission_id=m.id
      LEFT JOIN codex_attempt_metadata c ON c.attempt_id=a.id WHERE m.id=$1 AND a.id=$2`,[p.mission_id,p.attempt_id]);
    const state=check.rows[0];
    if(!state) throw new MissionError('attempt_not_found',404);
    if(state.current_attempt_id!==p.attempt_id||state.attempt_status!=='completed'||state.validation_state!=='passed'||!state.has_diff||!state.has_validation)
      throw new MissionError('publisher_validation_required',409);
    if(state.mission_head!==p.head_sha||state.attempt_head!==p.head_sha) throw new MissionError('publisher_head_mismatch',409);
    const action=await this.prepareAction('agentimpact-publisher','publisher_publish',p,'sensitive');
    return response(request,{ok:false,status:'approval_required',error_code:'approval_required',data:action});
  }

  private async publisherPublish(request: OperatorRequest): Promise<OperatorResponse> {
    if(this.env.AGENTIMPACT_PUBLISHER_ENABLED!=='1') return response(request,{ok:false,status:'blocked',error_code:'publisher_disabled'});
    if(!this.env.GITHUB_APP_ID||!this.env.GITHUB_APP_INSTALLATION_ID) return response(request,{ok:false,status:'blocked',error_code:'publisher_credential_not_configured'});
    await this.validateApproved(request,'publisher_publish');
    return response(request,{ok:false,status:'blocked',error_code:'publisher_worker_unavailable'});
  }

  private async deployPrepare(request: OperatorRequest): Promise<OperatorResponse> {
    const p=request.parameters;
    if(p.release_id===p.rollback_release_id) throw new MissionError('rollback_release_must_differ',400);
    if(!String(p.release_id).endsWith(`-${String(p.source_commit).slice(0,12)}`)) throw new MissionError('release_source_mismatch',400);
    if(p.target==='production'&&!['main','master'].includes(String(p.base_branch))) throw new MissionError('production_branch_required',409);
    const published=await this.pool.query(`SELECT 1 FROM agent_actions WHERE id=$1
      AND profile='agentimpact-publisher' AND intent='publisher_publish' AND status='executed'
      AND payload->>'head_sha'=$2 AND payload->>'repository'=$3 AND payload->>'base_branch'=$4
      AND jsonb_typeof(payload->'pull_request_number')='number'`,
      [p.publisher_action_id,p.source_commit,p.repository,p.base_branch]);
    if(!published.rowCount) throw new MissionError('published_artifact_required',409);
    const action=await this.prepareAction('agentimpact-deployer','deploy_release',p,'sensitive');
    return response(request,{ok:false,status:'approval_required',error_code:'approval_required',data:action});
  }

  private async deployExecute(request: OperatorRequest): Promise<OperatorResponse> {
    if(this.env.AGENTIMPACT_DEPLOY_ENABLED!=='1') return response(request,{ok:false,status:'blocked',error_code:'deploy_disabled'});
    // Validation is read-only here: the separately privileged deploy.sh is
    // the sole consumer and atomically transitions approved -> executing.
    // Never burn the one-shot approval merely to report an unavailable worker.
    await this.validateApproved(request,'deploy_release');
    return response(request,{ok:false,status:'blocked',error_code:'deploy_worker_unavailable'});
  }

  private async validateApproved(request:OperatorRequest,intent:string):Promise<Action> {
    const action=await this.loadAction(String(request.parameters.action_id));
    if(action.intent!==intent||action.payload_hash!==request.parameters.payload_hash||action.status!=='approved')
      throw new MissionError('approval_invalid',403);
    if(!action.approval_expires_at||Date.parse(action.approval_expires_at)<=Date.now())
      throw new MissionError('approval_invalid',409);
    const approval=await this.pool.query(`SELECT 1 FROM agent_approvals WHERE action_id=$1 AND payload_hash=$2
      AND decision='approved' AND approver='human-admin' AND expires_at>clock_timestamp()`,[action.id,action.payload_hash]);
    if(!approval.rowCount) throw new MissionError('approval_invalid',403);
    return action;
  }

  private async prepareAction(profile:string,intent:string,payload:unknown,risk:string) {
    const canonical={intent,payload,nonce:randomUUID()};
    const hash=digest(canonical);
    const r=await this.pool.query(`INSERT INTO agent_actions(profile,intent,targets,payload,payload_hash,risk_level,dry_run,status,approval_expires_at)
      VALUES($1,$2,'[]'::jsonb,$3::jsonb,$4,$5,false,'approval_requested',clock_timestamp()+interval '15 minutes')
      RETURNING id,payload_hash,status,approval_expires_at`,[profile,intent,JSON.stringify(payload),hash,risk]);
    await this.pool.query(`INSERT INTO agent_audit_events(action_id,event_type,actor,details)
      VALUES($1,'approval_requested',$2,$3::jsonb)`,[r.rows[0].id,profile,JSON.stringify({payload_hash:hash,intent})]);
    return r.rows[0];
  }

  private async loadAction(id:string):Promise<Action> {
    const row=(await this.pool.query<Action>(`SELECT id,profile,intent,payload_hash,status,approval_expires_at,payload,created_at
      FROM agent_actions WHERE id=$1`,[id])).rows[0];
    if(!row) throw new MissionError('action_not_found',404);
    return row;
  }

  private async claimApproved(request:OperatorRequest,intent:string,claimant:string):Promise<Action> {
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      const action=(await client.query<Action>(`SELECT id,profile,intent,payload_hash,status,approval_expires_at,payload,created_at
        FROM agent_actions WHERE id=$1 FOR UPDATE`,[request.parameters.action_id])).rows[0];
      if(!action||action.intent!==intent||action.payload_hash!==request.parameters.payload_hash||action.status!=='approved')
        throw new MissionError('approval_invalid',403);
      if(!action.approval_expires_at||Date.parse(action.approval_expires_at)<=Date.now()) throw new MissionError('approval_invalid',409);
      const approval=await client.query(`SELECT 1 FROM agent_approvals WHERE action_id=$1 AND payload_hash=$2
        AND decision='approved' AND approver='human-admin' AND expires_at>clock_timestamp() FOR SHARE`,[action.id,action.payload_hash]);
      if(!approval.rowCount) throw new MissionError('approval_invalid',403);
      const claimed=await client.query(`UPDATE agent_actions SET status='executing',execution_claimed_at=clock_timestamp(),
        execution_claimed_by=$2 WHERE id=$1 AND status='approved' RETURNING id`,[action.id,claimant]);
      if(!claimed.rowCount) throw new MissionError('approval_invalid',409);
      await client.query(`INSERT INTO agent_audit_events(action_id,event_type,actor,details)
        VALUES($1,'executing',$2,$3::jsonb)`,[action.id,claimant,JSON.stringify({payload_hash:action.payload_hash,intent})]);
      await client.query('COMMIT');
      return action;
    } catch(error) { await client.query('ROLLBACK').catch(()=>undefined); throw error; }
    finally { client.release(); }
  }

  private async failClaim(action:Action,error:string,actor:string):Promise<void> {
    await this.pool.query(`UPDATE agent_actions SET status='failed',executed_at=clock_timestamp(),error_message=$2
      WHERE id=$1 AND status='executing' AND execution_claimed_by=$3`,[action.id,error,actor]);
    await this.pool.query(`INSERT INTO agent_audit_events(action_id,event_type,actor,details)
      VALUES($1,'failed',$2,$3::jsonb)`,[action.id,actor,JSON.stringify({error,payload_hash:action.payload_hash})]);
  }
}
