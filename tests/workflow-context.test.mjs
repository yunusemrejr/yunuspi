import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);
const release=path.resolve(import.meta.dirname,'..');
let agent=path.join(release,'agent');try{await fs.access(agent);}catch{agent=path.resolve(release,'..');}
const {conversationContext,captureWorkflowContext,workflowDrift,reviewWorkflowBrief}=await import(pathToFileURL(path.join(agent,'extensions/lib/project-intelligence/workflow-context.mjs')));
const {resolveProjectIdentity}=await import(pathToFileURL(path.join(agent,'extensions/lib/project-intelligence/identity.mjs')));
const sha='a'.repeat(40),otherSha='b'.repeat(40);

test('conversation branch, native snapshot receipts and project Git remain separate namespaces',()=>{
  const conversation=conversationContext({sessionManager:{getSessionId:()=> 'session-1',getLeafId:()=> 'leaf-9',getBranch:()=>[
    {type:'message',id:'user-1',message:{role:'user',content:'PRIVATE_SYNTHETIC_PROMPT'}},
    {type:'custom',id:'snapshot-1',customType:'pi-checkpoint',data:{beforeCommit:sha,afterCommit:otherSha,privateText:'MUST_NOT_COPY'}},
  ]}});
  assert.equal(conversation.branchHead,'leaf-9');assert.equal(conversation.latestUserEntry,'user-1');
  assert.equal(conversation.nativeCheckpoint.afterCommit,otherSha);
  assert.match(conversation.nativeCheckpoint.status,/not resolved as project Git objects/);
  assert.doesNotMatch(JSON.stringify(conversation),/PRIVATE|MUST_NOT_COPY/);
});

test('linked worktrees share project identity but keep distinct checkouts, branches and scope baselines',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'workflow-context-'));
  const root=path.join(temp,'repo'),linked=path.join(temp,'linked'),stateDir=path.join(temp,'state');
  const git=(...args)=>exec('git',['-C',root,...args],{env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'}});
  try{
    await fs.mkdir(root);await git('init','-q','-b','main');
    await fs.writeFile(path.join(root,'index.js'),'export const fixture = true;');
    await git('add','index.js');await git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Synthetic fixture');
    await git('worktree','add','-q','-b','revision',linked);
    const first=await resolveProjectIdentity(root,{stateDir}),second=await resolveProjectIdentity(linked,{stateDir});
    assert.equal(first.id,second.id);assert.notEqual(first.checkoutId,second.checkoutId);
    const conversation={sessionId:'one',branchHead:'conversation-head'};
    const before=await captureWorkflowContext(first,conversation);
    const after=await captureWorkflowContext(second,conversation);
    assert.equal(before.projectGit.branch,'main');assert.equal(after.projectGit.branch,'revision');
    assert.match(workflowDrift(before,after),/different project, checkout or conversation/);
    await git('checkout','-qb','new-scope');
    const changed=await captureWorkflowContext(first,conversation);
    assert.equal(changed.projectGit.branch,'new-scope','uses a fresh Git observation rather than cached discovery');
    assert.match(workflowDrift(before,changed),/Git changed/);
    const prior=process.env.GIT_CONFIG_COUNT;
    process.env.GIT_CONFIG_COUNT='broken';
    try{assert.equal((await captureWorkflowContext(first,conversation)).projectGit.branch,'new-scope','inherited Git config cannot redirect native observations');}
    finally{if(prior===undefined)delete process.env.GIT_CONFIG_COUNT;else process.env.GIT_CONFIG_COUNT=prior;}
  }finally{await fs.rm(temp,{recursive:true,force:true});}
});

test('reviews receive dependency direction and the scope discussion inside one shared budget',()=>{
  const workflow={projectId:'project',checkoutId:'checkout',conversation:{sessionId:'session',branchHead:'leaf'},projectGit:{head:sha,branch:'main'}};
  const scope=JSON.stringify({discussion:'Preserve explicit typography and replace distracting repeated movement.',status:'complete'});
  const text=reviewWorkflowBrief({graph:'src/client.ts -imports-> src/motion.ts\n'.repeat(100),workflow,scope,baseline:workflow});
  assert.ok(text.length<=5000);assert.match(text,/Preserve explicit typography/);assert.match(text,/src\/client.ts -imports-> src\/motion.ts/);
  assert.match(text,/source edits.*independent checks/);assert.match(text,/condensed proposals, not accepted requirements/);
  assert.match(reviewWorkflowBrief({graph:'',workflow,scope,baseline:{...workflow,projectGit:{branch:'old',head:otherSha}}}),/Git changed/);
  assert.match(workflowDrift(workflow,{...workflow,conversation:{...workflow.conversation,latestUserEntry:'correction'}}),/user direction changed/);
  assert.match(workflowDrift(workflow,{...workflow,conversation:{...workflow.conversation,nativeCheckpoint:{entryId:'checkpoint',afterCommit:otherSha}}}),/Native checkpoint changed/);
  assert.match(workflowDrift(workflow,{...workflow,conversation:{...workflow.conversation,branchHead:'descendant'}}),/does not prove ancestry/);
});
