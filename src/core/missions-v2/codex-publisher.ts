import { createHash } from 'node:crypto';
import { MissionError } from './model.js';

export type PublishRequest={repoId:string;baseSha:string;branch:string;patch:string;force:boolean;title:string};
export type PublishResult={branch:string;prUrl:string;commitSha:string;replayed:boolean};
export interface CodexPublisher{publish(request:PublishRequest):Promise<PublishResult>}
export class DisabledCodexPublisher implements CodexPublisher{async publish(_request:PublishRequest):Promise<PublishResult>{throw new MissionError('publisher_credential_not_configured',503);}}
export class FakeCodexPublisher implements CodexPublisher{
  private receipts=new Map<string,PublishResult>();constructor(private repos:ReadonlySet<string>){ }
  async publish(request:PublishRequest){if(!this.repos.has(request.repoId))throw new MissionError('publisher_repo_forbidden',403);
    if(request.branch==='main'||request.branch==='master')throw new MissionError('publisher_protected_branch',403);
    if(request.force)throw new MissionError('publisher_force_push_forbidden',403);
    const key=createHash('sha256').update(JSON.stringify(request)).digest('hex'),existing=this.receipts.get(key);
    if(existing)return{...existing,replayed:true};const result={branch:request.branch,commitSha:key.slice(0,40),
      prUrl:`https://example.invalid/${request.repoId}/pull/${this.receipts.size+1}`,replayed:false};this.receipts.set(key,result);return result;}
}
