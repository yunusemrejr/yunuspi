import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {excludeFromGitStatus,resolveProjectIdentity} from '../agent/extensions/lib/project-identity.ts';

// The first session in a git repository wrote .pi-project-id into the working
// tree, so `git status` was dirty before the model did anything.
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null'}});
function repo() {
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'pid-exclude-')));
  git(dir,'init','-q');
  git(dir,'-c','user.name=t','-c','user.email=t@t','commit','-q','--allow-empty','-m','init');
  return dir;
}

test('a generated project id file stays out of git status, once, and tracked .gitignore is untouched',()=>{
  const dir=repo();
  const registry=fs.mkdtempSync(path.join(os.tmpdir(),'pid-registry-'));
  try {
    fs.writeFileSync(path.join(dir,'.gitignore'),'node_modules\n');
    git(dir,'add','.gitignore');git(dir,'-c','user.name=t','-c','user.email=t@t','commit','-q','-m','ignore');
    resolveProjectIdentity(dir,{},{PI_PROJECTS_DIR:registry});
    assert.ok(fs.existsSync(path.join(dir,'.pi-project-id')),'the id file is still written');
    assert.equal(git(dir,'status','--porcelain'),'');
    fs.mkdirSync(path.join(dir,'.pi','tasks','run-1'),{recursive:true});
    fs.writeFileSync(path.join(dir,'.pi','tasks','run-1','out.log'),'x');
    excludeFromGitStatus(dir,['.pi-project-id','.pi/tasks']);
    excludeFromGitStatus(dir,['.pi-project-id','.pi/tasks']);
    assert.equal(git(dir,'status','--porcelain'),'');
    const lines=fs.readFileSync(path.join(dir,'.git','info','exclude'),'utf8').split('\n').filter(l=>l.startsWith('/'));
    assert.deepEqual(lines,['/.pi-project-id','/.pi/tasks']);
    assert.equal(fs.readFileSync(path.join(dir,'.gitignore'),'utf8'),'node_modules\n');
  } finally { fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(registry,{recursive:true,force:true}); }
});

test('a linked worktree writes to the shared exclude file and a missing trailing newline is kept intact',()=>{
  const dir=repo();
  const wt=path.join(os.tmpdir(),`pid-wt-${process.pid}`);
  try {
    git(dir,'worktree','add','-q',wt,'-b','side');
    fs.mkdirSync(path.join(dir,'.git','info'),{recursive:true});
    fs.writeFileSync(path.join(dir,'.git','info','exclude'),'# mine');
    fs.writeFileSync(path.join(wt,'.pi-project-id'),'prj_x\n');
    assert.match(git(wt,'status','--porcelain'),/\.pi-project-id/);
    excludeFromGitStatus(wt,['.pi-project-id']);
    assert.equal(git(wt,'status','--porcelain'),'');
    assert.equal(fs.readFileSync(path.join(dir,'.git','info','exclude'),'utf8'),'# mine\n/.pi-project-id\n');
  } finally { fs.rmSync(wt,{recursive:true,force:true});fs.rmSync(dir,{recursive:true,force:true}); }
});

test('a subdirectory anchor is excluded by its path from the repository root; no git is a no-op',()=>{
  const dir=repo();
  const plain=fs.mkdtempSync(path.join(os.tmpdir(),'pid-plain-'));
  try {
    fs.mkdirSync(path.join(dir,'pkg'));
    fs.writeFileSync(path.join(dir,'pkg','.pi-project-id'),'prj_y\n');
    excludeFromGitStatus(path.join(dir,'pkg'),['.pi-project-id']);
    assert.equal(git(dir,'status','--porcelain'),'');
    assert.match(fs.readFileSync(path.join(dir,'.git','info','exclude'),'utf8'),/^\/pkg\/\.pi-project-id$/m);
    assert.doesNotThrow(()=>excludeFromGitStatus(plain,['.pi-project-id']));
    assert.doesNotThrow(()=>excludeFromGitStatus(path.join(plain,'missing'),['.pi-project-id']));
    assert.doesNotThrow(()=>excludeFromGitStatus(dir,['.pi-project-id'],{PATH:'/nonexistent'}));
  } finally { fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(plain,{recursive:true,force:true}); }
});
