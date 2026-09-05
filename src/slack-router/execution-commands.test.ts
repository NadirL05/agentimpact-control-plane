import { describe, expect, it, vi } from 'vitest';
import type { ExecutionControl } from '../core/missions-v2/execution.js';
import type { MissionStore } from '../core/missions-v2/store.js';
import { handleV2Command } from './missions-v2.js';
const id='d2bfaeb0-ed17-47e5-b77e-e7e020de38fb';
const base={type:'message' as const,team_id:'T1',event_id:'E1',channel:'C1',ts:'1.0',user:'U_NADIR'};
const store={allowsThread:async()=>true} as unknown as MissionStore;
describe('Slack execution commands',()=>{
  it('CANCEL acceptance follows durable control return',async()=>{
    const accepted=vi.fn();let finish!:()=>void;
    const execution={cancel:vi.fn(async()=>{await new Promise<void>(r=>{finish=r;});return {id};})} as unknown as ExecutionControl;
    const promise=handleV2Command({...base,text:`CANCEL ${id}`},store,'U_NADIR',accepted,execution);
    await Promise.resolve();expect(accepted).not.toHaveBeenCalled();
    finish();expect(await promise).toContain('Annulation enregistrée');expect(accepted).toHaveBeenCalledOnce();
  });
  it('does not acknowledge a failed durable cancellation',async()=>{
    const accepted=vi.fn();
    const execution={cancel:vi.fn(async()=>{throw new Error('PRIVATE_INPUT_SENTINEL');})} as unknown as ExecutionControl;
    await expect(handleV2Command({...base,text:`CANCEL ${id}`},store,'U_NADIR',accepted,execution)).rejects.toThrow('v2_admission_unavailable');
    expect(accepted).not.toHaveBeenCalled();
  });
  it('RETRY uses event identity and stored policy, with no worker launch',async()=>{
    const retry=vi.fn(async()=>({id,attempt_number:2,status:'queued'}));
    const result=await handleV2Command({...base,text:`RETRY ${id}`},store,'U_NADIR',()=>{}, {retry} as unknown as ExecutionControl);
    expect(result).toContain('tentative 2');
    expect(retry).toHaveBeenCalledWith(id,{principal:'slack:T1:U_NADIR',key:'retry:T1:E1'});
  });
  it('refuses the wrong Slack identity, malformed ID and disabled F',async()=>{
    const cancel=vi.fn();
    expect(await handleV2Command({...base,user:'other',text:`CANCEL ${id}`},store,'U_NADIR',()=>{}, {cancel} as unknown as ExecutionControl)).toContain('réservée');
    expect(await handleV2Command({...base,text:'CANCEL ../outside'},store,'U_NADIR',()=>{}, {cancel} as unknown as ExecutionControl)).toContain('Format');
    expect(await handleV2Command({...base,text:`CANCEL ${id}`},store,'U_NADIR',()=>{})).toContain('désactivé');
    expect(cancel).not.toHaveBeenCalled();
  });
  it('STATUS exposes bounded requested execution fields from the DB snapshot',async()=>{
    const status={id,project:'IMANE',mission_state:'running',phase:'executing',blocked_reason:null,
      active_attempt:{id:'attempt',attempt_number:1,status:'running'},assigned_worker:'fake-supervisor',
      lease_status:'valid',heartbeat_age:4.5,dependencies:[],budget_state:'consuming',budget_reservation_state:'consuming',
      quota_source:'none',quota_state:'UNKNOWN',quota_checked_at:null,approval_state:'valid'};
    const execution={status:async()=>status} as unknown as ExecutionControl;
    const text=await handleV2Command({...base,text:`STATUS ${id}`},store,'U_NADIR',()=>{},execution);
    for(const part of ['running','executing','fake-supervisor','Lease : valid','heartbeat : 4 s','Dépendances : aucune',
      'Budget de test : consuming','quota fournisseur : UNKNOWN','Source quota : none','vérifié à : jamais','approval : valid']) expect(text).toContain(part);
  });
});
