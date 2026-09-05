import {codexOutputSchema,codexWorkerConfig,type CodexWork,type CodexWorkerConfig} from './codex-worker.js';
import {CodexStateStore} from './codex-store.js';
import {CodexResultValidator,type ValidationInput} from './codex-workspace.js';
import type {SignedWorkerRequest} from './codex-transport.js';
import {ExecutionControl} from './execution.js';
import {digest,MissionError} from './model.js';

export type AssignmentProvider=(attemptId:string)=>Promise<CodexWork>;
export type ValidationPolicy=(work:CodexWork)=>Pick<ValidationInput,'maxDiffBytes'|'requiredTests'>;

/** Authenticated Unix-socket dispatcher. It is deliberately not mounted on Hono. */
export class CodexControlDispatcher {
  constructor(private control:ExecutionControl,private state:CodexStateStore,private assignments:AssignmentProvider,
    private validator:CodexResultValidator,private policy:ValidationPolicy,private config:CodexWorkerConfig=codexWorkerConfig()){}
  async dispatch(request:SignedWorkerRequest){
    if(!this.config.enabled)throw new MissionError(this.config.blockedReason??'codex_worker_disabled',503);
    const {message,payload}=request,work=await this.assignments(message.attempt_id);
    if(message.worker_instance_id!==work.worker_instance_id||message.fencing_token!==work.fencing_token||message.attempt_id!==work.attempt_id)
      throw new MissionError('fencing_rejected',409);
    const proof={attempt_id:work.attempt_id,worker_instance_id:work.worker_instance_id,fencing_token:work.fencing_token};
    const meta={principal:`transport:${work.worker_instance_id}`,key:message.nonce};
    switch(message.operation){
      case 'claim':
        if(digest((payload as {contract?:unknown})?.contract)!==digest(work))throw new MissionError('codex_attempt_binding_invalid',409);
        await this.state.register(work,this.config);await this.control.claim(work.attempt_id,work.worker_instance_id,proof,meta);
        await this.state.metric('codex_attempts_total');return{accepted:true};
      case 'start':await this.control.start(proof,work.worker_instance_id,meta);return{accepted:true};
      case 'heartbeat':{
        await this.control.heartbeat(proof,work.worker_instance_id,meta);const status=await this.control.status(work.mission_id);
        return{accepted:true,cancel_requested:['cancel_requested','cancelling'].includes(status.mission_state)};}
      case 'progress':{
        const phase=(payload as {phase?:unknown})?.phase;if(!['preparing','executing','validating'].includes(String(phase)))throw new MissionError('invalid_progress',400);
        await this.control.progress(proof,work.worker_instance_id,{phase:phase as 'preparing'|'executing'|'validating'},meta);return{accepted:true};}
      case 'complete':return this.complete(work,payload,meta);
      case 'cancel':{
        const kind=(payload as {kind?:unknown})?.kind;if(kind!=='stopped'&&kind!=='unknown')throw new MissionError('invalid_stop_proof',400);
        if((payload as {reason?:unknown}).reason==='deadline_exceeded')await this.state.metric('codex_timeouts_total');
        await this.control.reconcile(work.attempt_id,{kind,worker_instance_id:work.worker_instance_id,fencing_token:work.fencing_token},meta);return{accepted:true};}
      case 'inspect':return this.control.status(work.mission_id);
      case 'collect':throw new MissionError('collect_is_worker_local',403);
    }
  }
  private async complete(work:CodexWork,payload:unknown,meta:{principal:string;key:string}){
    const body=payload as {exit_code?:unknown;output?:unknown},parsed=codexOutputSchema.safeParse(body?.output);
    if(!parsed.success){await this.state.metric('codex_output_invalid_total');throw new MissionError('codex_output_invalid',400);}
    await this.state.result(work.attempt_id,parsed.data,digest(parsed.data));
    await this.state.artifacts(work.attempt_id,parsed.data.artifacts);
    if(body.exit_code!==0||parsed.data.outcome==='failed'){await this.state.metric('codex_attempts_failed_total');
      return this.control.complete({attempt_id:work.attempt_id,worker_instance_id:work.worker_instance_id,fencing_token:work.fencing_token},work.worker_instance_id,
        {outcome:'failed',retryable:parsed.data.retryable,error_code:'worker_failed'},meta);}
    if(parsed.data.base_sha!==work.base_sha)throw new MissionError('codex_base_sha_mismatch',409);
    await this.state.validation(work.attempt_id,'running');
    try{await this.validator.validate({workspaceRoot:this.config.workspaceRoot,workspacePath:work.workspace_path,baseSha:work.base_sha,
      allowedPaths:work.allowed_paths,reportedPaths:parsed.data.changed_paths,testResults:parsed.data.test_results,maxDiffBytes:this.policy(work).maxDiffBytes,
      requiredTests:this.policy(work).requiredTests});await this.state.validation(work.attempt_id,'passed');}
    catch(error){await this.state.validation(work.attempt_id,'quarantined');await this.state.metric('codex_validation_failures_total');
      await this.control.complete({attempt_id:work.attempt_id,worker_instance_id:work.worker_instance_id,fencing_token:work.fencing_token},work.worker_instance_id,
        {outcome:'failed',retryable:false,error_code:'validation_failed'},meta);throw error;}
    return this.control.complete({attempt_id:work.attempt_id,worker_instance_id:work.worker_instance_id,fencing_token:work.fencing_token},work.worker_instance_id,
      {outcome:'completed'},meta);
  }
}
