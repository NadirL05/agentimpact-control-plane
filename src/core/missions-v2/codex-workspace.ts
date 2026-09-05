import { lstat, mkdir, realpath, readFile } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { MissionError } from './model.js';

export type RepoRegistration={repoId:string;mirrorPath:string;allowedPaths:string[]};
export type GitCommand=(args:string[],cwd?:string)=>Promise<{exitCode:number;stdout:string;overflowed?:boolean}>;
export const nodeGitCommand:GitCommand=(args,cwd)=>new Promise((resolveCommand,reject)=>{
  const child=spawn('/usr/bin/git',args,{cwd,env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent'},shell:false,stdio:['ignore','pipe','pipe']});
  let stdout='',bytes=0,overflowed=false;child.stdout.on('data',(b:Buffer)=>{bytes+=b.length;
    if(bytes<=1048576)stdout+=b.toString('utf8');else if(!overflowed){overflowed=true;child.kill('SIGTERM');}});
  child.stderr.on('data',()=>undefined);child.once('error',reject);child.once('close',code=>resolveCommand({exitCode:code??1,stdout,overflowed}));
});
export class CodexWorkspaceManager {
  private repos:Map<string,RepoRegistration>;
  constructor(readonly root:string,repos:RepoRegistration[],private git:GitCommand=nodeGitCommand){
    if(!isAbsolute(root)||repos.some(repo=>!isAbsolute(repo.mirrorPath)))throw new MissionError('workspace_root_invalid',400);
    this.repos=new Map(repos.map(repo=>[repo.repoId,repo]));
  }
  candidate(attemptId:string){if(!z.string().uuid().safeParse(attemptId).success)throw new MissionError('invalid_attempt_id',400);
    const canonical=resolve(this.root,'attempts',attemptId,'workspace');
    if(relative(this.root,canonical).startsWith(`..${sep}`)||canonical===this.root)throw new MissionError('workspace_path_escape');
    return{workspace_root:this.root,candidate_path:join(this.root,'attempts',attemptId,'workspace'),canonical_path:canonical};}
  allowedPaths(repoId:string){const repo=this.repos.get(repoId);if(!repo)throw new MissionError('repo_not_allowed',403);return[...repo.allowedPaths];}
  async prepare(repoId:string,attemptId:string,baseSha:string,branch:string){const repo=this.repos.get(repoId);if(!repo)throw new MissionError('repo_not_allowed',403);
    if(!/^[0-9a-f]{40}$/.test(baseSha)||!/^(?!main$|master$)[A-Za-z0-9][A-Za-z0-9_.\/-]{0,199}$/.test(branch))throw new MissionError('workspace_contract_invalid',400);
    const workspace=this.candidate(attemptId);await mkdir(resolve(workspace.canonical_path,'..'),{recursive:true,mode:0o700});
    const rootReal=await realpath(this.root),parentReal=await realpath(resolve(workspace.canonical_path,'..'));
    if(relative(rootReal,parentReal).startsWith('..'))throw new MissionError('workspace_symlink_escape');
    for(const args of [['clone','--no-checkout','--no-local',repo.mirrorPath,workspace.canonical_path],
      ['-C',workspace.canonical_path,'checkout','--detach',baseSha],['-C',workspace.canonical_path,'switch','-c',branch]]){
      const result=await this.git(args);if(result.exitCode!==0)throw new MissionError('workspace_prepare_failed',503);
    }return{...workspace,allowed_paths:repo.allowedPaths};}
}

export type ValidationInput={workspaceRoot:string;workspacePath:string;baseSha:string;allowedPaths:string[];
  reportedPaths:string[];testResults:Array<{name:string;exit_code:number}>;maxDiffBytes:number;
  requiredTests?:Array<{name:string;file:string;args:string[]}>};
export type TestCommand=(file:string,args:string[],cwd:string)=>Promise<number>;
const nodeTestCommand:TestCommand=(file,args,cwd)=>new Promise((resolveCommand,reject)=>{const child=spawn(file,args,{cwd,shell:false,
  env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/nonexistent'},stdio:['ignore','ignore','ignore']});child.once('error',reject);child.once('close',code=>resolveCommand(code??1));});
const secretPatterns=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/,/\bxox[baprs]-[A-Za-z0-9-]{25,}/,/\bsk-(?:proj-)?[A-Za-z0-9_-]{30,}/];
export const allowedWorkspacePath=(file:string,allowed:string[])=>allowed.some(prefix=>file===prefix||file.startsWith(`${prefix.replace(/\/$/,'')}/`));
export class CodexResultValidator {
  constructor(private git:GitCommand=nodeGitCommand,private testCommand:TestCommand=nodeTestCommand){}
  async validate(input:ValidationInput){const root=await realpath(input.workspaceRoot),workspace=await realpath(input.workspacePath);
    if(relative(root,workspace).startsWith('..'))throw new MissionError('workspace_escape');
    const untrackedResult=await this.git(['-C',workspace,'ls-files','--others','--exclude-standard','-z']);
    if(untrackedResult.exitCode!==0||untrackedResult.overflowed)throw new MissionError('validation_git_failed');
    const untracked=untrackedResult.stdout.split('\0').filter(Boolean).map(file=>posix.normalize(file));
    if(untracked.length>500||untracked.some(file=>file.startsWith('../')||file.startsWith('/')||!allowedWorkspacePath(file,input.allowedPaths)))
      throw new MissionError('validation_path_forbidden');
    if(untracked.length){const intent=await this.git(['-C',workspace,'add','--intent-to-add','--',...untracked]);if(intent.exitCode!==0)throw new MissionError('validation_git_failed');}
    const diff=await this.git(['-C',workspace,'diff','--binary',input.baseSha,'--']);if(diff.exitCode!==0||diff.overflowed)throw new MissionError('validation_git_failed');
    const names=await this.git(['-C',workspace,'diff','--name-only','-z',input.baseSha,'--']);if(names.exitCode!==0||names.overflowed)throw new MissionError('validation_git_failed');
    const changed=names.stdout.split('\0').filter(Boolean).map(file=>posix.normalize(file));
    if(!changed.length||Buffer.byteLength(diff.stdout)>input.maxDiffBytes)throw new MissionError('validation_diff_invalid');
    if(changed.some(file=>file.startsWith('../')||file.startsWith('/')||!allowedWorkspacePath(file,input.allowedPaths)))throw new MissionError('validation_path_forbidden');
    if([...changed].sort().join('\0')!==[...input.reportedPaths].map(p=>posix.normalize(p)).sort().join('\0'))throw new MissionError('validation_report_mismatch');
    if(secretPatterns.some(pattern=>pattern.test(diff.stdout)))throw new MissionError('validation_secret_detected');
    for(const file of changed){const full=resolve(workspace,file);let cursor=workspace;
      for(const component of file.split('/')){cursor=join(cursor,component);const componentStat=await lstat(cursor).catch(()=>null);
        if(componentStat?.isSymbolicLink()){const target=await realpath(cursor);if(relative(workspace,target).startsWith('..'))throw new MissionError('validation_symlink_escape');}}
      const stat=await lstat(full).catch(()=>null);if(!stat)continue;if(stat.isSymbolicLink()){
      const target=await realpath(full);if(relative(workspace,target).startsWith('..'))throw new MissionError('validation_symlink_escape');}
      if(stat.isFile()){const content=await readFile(full,'utf8').catch(()=> '');if(secretPatterns.some(pattern=>pattern.test(content)))throw new MissionError('validation_secret_detected');}}
    if(input.testResults.some(test=>test.exit_code!==0))throw new MissionError('validation_tests_failed');
    const trustedTests=[];for(const test of input.requiredTests??[]){if(!isAbsolute(test.file)||test.args.some(arg=>arg.includes('\0')))throw new MissionError('validation_test_invalid',400);
      const exit_code=await this.testCommand(test.file,test.args,workspace);trustedTests.push({name:test.name,exit_code});if(exit_code!==0)throw new MissionError('validation_tests_failed');}
    return{state:'passed' as const,changed_paths:changed,diff_bytes:Buffer.byteLength(diff.stdout),trusted_tests:trustedTests};}
}
