import {afterEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {CodexWorkspaceManager,CodexResultValidator} from './codex-workspace.js';
const exec=promisify(execFile),roots:string[]=[];
const git=async(...args:string[])=>(await exec('/usr/bin/git',args,{env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}})).stdout.trim();
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'r8-identity-'));roots.push(root);
  const mirror=join(root,'mirror');await mkdir(mirror);await git('init','--template=',mirror);
  await git('-C',mirror,'config','user.name','Fixture');await git('-C',mirror,'config','user.email','fixture@example.invalid');
  await writeFile(join(mirror,'increment.js'),'exports.increment = value => value;\n');
  await git('-C',mirror,'add','.');await git('-C',mirror,'commit','-m','base');
  const base=await git('-C',mirror,'rev-parse','HEAD'),id=randomUUID(),branch='codex/r8';
  const manager=new CodexWorkspaceManager(root,[{repoId:'r8',mirrorPath:mirror,allowedPaths:['increment.js']}]);
  const workspace=(await manager.prepare('r8',id,base,branch)).canonical_path;
  return{root,mirror,base,id,branch,manager,workspace};
}
it('accepts the exact repo, attempt, branch and HEAD with an allowed working-tree diff',async()=>{
  const f=await fixture();await expect(f.manager.assertIdentity('r8',f.id,f.base,f.branch)).resolves.toBeUndefined();
  await writeFile(join(f.workspace,'increment.js'),'exports.increment = value => value + 1;\n');
  const result=await new CodexResultValidator().validate({workspaceRoot:f.root,workspacePath:f.workspace,baseSha:f.base,
    identity:{repoId:'r8',attemptId:f.id,branch:f.branch,mirrorPath:f.mirror},allowedPaths:['increment.js'],
    reportedPaths:['increment.js'],testResults:[],maxDiffBytes:2048});
  expect(result.state).toBe('passed');
});
it('rejects a wrong SHA and a mismatched attempt path',async()=>{
  const f=await fixture();await expect(f.manager.assertIdentity('r8',f.id,'f'.repeat(40),f.branch)).rejects.toMatchObject({code:'workspace_identity_mismatch'});
  await expect(f.manager.assertIdentity('r8',randomUUID(),f.base,f.branch,f.workspace)).rejects.toMatchObject({code:'workspace_identity_mismatch'});
});
it('rejects changed HEAD after preparation and before diff validation',async()=>{
  const f=await fixture();await git('-C',f.workspace,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','changed head');
  await expect(f.manager.assertIdentity('r8',f.id,f.base,f.branch)).rejects.toMatchObject({code:'workspace_identity_mismatch'});
  await expect(new CodexResultValidator().validate({workspaceRoot:f.root,workspacePath:f.workspace,baseSha:f.base,
    identity:{repoId:'r8',attemptId:f.id,branch:f.branch,mirrorPath:f.mirror},allowedPaths:['increment.js'],
    reportedPaths:[],testResults:[],maxDiffBytes:2048})).rejects.toMatchObject({code:'workspace_identity_mismatch'});
});
it('rejects repository substitution and a changed branch',async()=>{
  const f=await fixture();await git('-C',f.workspace,'remote','set-url','origin',join(f.root,'other'));
  await expect(f.manager.assertIdentity('r8',f.id,f.base,f.branch)).rejects.toMatchObject({code:'workspace_identity_mismatch'});
  await git('-C',f.workspace,'remote','set-url','origin',f.mirror);await git('-C',f.workspace,'switch','-c','other');
  await expect(f.manager.assertIdentity('r8',f.id,f.base,f.branch)).rejects.toMatchObject({code:'workspace_identity_mismatch'});
});
it('rechecks identity after trusted tests before accepting the result',async()=>{
  const f=await fixture();await writeFile(join(f.workspace,'increment.js'),'exports.increment = value => value + 1;\n');
  const validator=new CodexResultValidator(undefined,async()=>{
    await git('-C',f.workspace,'switch','-c','test-changed-branch');return 0;
  });
  await expect(validator.validate({workspaceRoot:f.root,workspacePath:f.workspace,baseSha:f.base,
    identity:{repoId:'r8',attemptId:f.id,branch:f.branch,mirrorPath:f.mirror},allowedPaths:['increment.js'],
    reportedPaths:['increment.js'],testResults:[],maxDiffBytes:2048,
    requiredTests:[{name:'local-double',file:'/usr/bin/node',args:[]}]})).rejects.toMatchObject({code:'workspace_identity_mismatch'});
});
