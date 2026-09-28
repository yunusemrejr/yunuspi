import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';

const jiti=createJiti(import.meta.dirname);

test('git_info review and log work in a repository that has no commits yet',async()=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path'),{execFileSync}=await import('node:child_process');
 const {runGitInfo}=await jiti.import('../agent/extensions/git-tools.ts');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'unborn-'));
 try{
  execFileSync('git',['init','-q'],{cwd:dir});
  fs.writeFileSync(path.join(dir,'a.ts'),`export const key = "${['sk','abcdefghijklmnopqrstuvwxyz0123'].join('-')}";\n`);
  const review=JSON.parse(await runGitInfo({action:'review'},dir));
  assert.match(review.target,/no commits yet/);
  assert.equal(review.untracked,1);
  assert.ok(review.risks.some(risk=>/possible API secret key/.test(risk)),'first-commit review still finds secrets');
  assert.equal(await runGitInfo({action:'log'},dir),'No commits yet on this branch.');
  assert.equal(await runGitInfo({action:'show'},dir),'No commits yet on this branch.');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
