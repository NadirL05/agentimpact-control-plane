import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SupersetParseError } from './json.js';
import { mapSupersetCliToRpc, buildCodexRateLimitsReadRpc, type SupersetRpcContext } from './rpc-client.js';

const context:SupersetRpcContext={missionId:randomUUID(),attemptId:randomUUID(),fencingToken:randomUUID()};

describe('SupersetRpcClient request mapper',()=>{
  it('maps only fixed backend operations to typed bridge requests',()=>{
    expect(mapSupersetCliToRpc(['workspaces','list','--project',randomUUID(),'--json'],context)).toMatchObject({operation:'workspace.list'});
    expect(mapSupersetCliToRpc(['terminals','create','--workspace',randomUUID(),'--command','printf AGENTIMPACT_SUPERSET_RPC_SMOKE','--json'],context))
      .toMatchObject({operation:'terminal.create',parameters:{profile:'smoke.echo'}});
    expect(buildCodexRateLimitsReadRpc(context)).toMatchObject({operation:'codex.rate_limits.read',parameters:{}});
  });
  it('never forwards arbitrary argv or a terminal shell command',()=>{
    expect(()=>mapSupersetCliToRpc(['shell','exec','id'],context)).toThrow(new SupersetParseError('rpc_operation_denied'));
    expect(()=>mapSupersetCliToRpc(['terminals','create','--workspace',randomUUID(),'--command','echo unsafe','--json'],context))
      .toThrow(new SupersetParseError('rpc_terminal_profile_required'));
  });
});
