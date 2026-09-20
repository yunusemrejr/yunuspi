import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync, spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'yunuspi-installer-test-'));
const repo=path.join(root,'repo'), script=path.join(repo,'scripts/install.mjs');
const source=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.mkdirSync(path.dirname(script),{recursive:true});fs.copyFileSync(path.join(source,'scripts/install.mjs'),script);
fs.writeFileSync(path.join(repo,'scripts/build-core.mjs'),'// owned build fixture');
fs.mkdirSync(path.join(repo,'docs'));fs.writeFileSync(path.join(repo,'docs/INSTALL.md'),'YunusPi source installation');
fs.writeFileSync(path.join(repo,'AGENTS.md'),'Owned-source development');
for(const name of ['package.json','package-lock.json'])fs.writeFileSync(path.join(repo,name),'{}');
fs.mkdirSync(path.join(repo,'core/coding-agent/src'),{recursive:true});
fs.writeFileSync(path.join(repo,'core/coding-agent/package.json'),JSON.stringify({name:'@yunuspi/coding-agent',version:'0.1.0'}));
fs.writeFileSync(path.join(repo,'core/coding-agent/src/cli.js'),'console.log("YunusPi fixture");');
fs.mkdirSync(path.join(repo,'agent/extensions'),{recursive:true});fs.writeFileSync(path.join(repo,'agent/extensions/manifest.json'),'{}');
fs.mkdirSync(path.join(repo,'agent/scripts'),{recursive:true});
fs.copyFileSync(path.join(source,'agent/scripts/pi-launch.sh'),path.join(repo,'agent/scripts/pi-launch.sh'));
fs.mkdirSync(path.join(repo,'config'));for(const name of ['settings','models'])fs.writeFileSync(path.join(repo,'config',name+'.example.json'),'{}');
fs.mkdirSync(path.join(repo,'agent/npm'),{recursive:true});fs.writeFileSync(path.join(repo,'agent/npm/package.json'),'{}');fs.writeFileSync(path.join(repo,'agent/test.txt'),'public');
const target=path.join(root,'target');
const bin=path.join(root,'bin');fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin,'npm'),`#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);if(a[0]==='run'&&process.env.YUNUSPI_TEST_BUILD_FAIL)process.exit(7);fs.appendFileSync(${JSON.stringify(path.join(root,'npm.log'))},JSON.stringify(a)+'\\n');if(a[0]==='run'){fs.mkdirSync('core/coding-agent/dist',{recursive:true});fs.copyFileSync('core/coding-agent/src/cli.js','core/coding-agent/dist/cli.js');}`,{mode:0o755});
const env={...process.env,PATH:bin+path.delimiter+process.env.PATH};
const run=(...args)=>spawnSync(process.execPath,[script,'--target',target,'--skip-needle',...args],{encoding:'utf8',env});
try {
assert.equal(run().status,0);assert(!fs.existsSync(target));
const outsideDocsDependency=path.join(root,'outside-docs-dependency');fs.mkdirSync(outsideDocsDependency);fs.writeFileSync(path.join(outsideDocsDependency,'private.txt'),'private fixture');fs.symlinkSync(outsideDocsDependency,path.join(repo,'docs/node_modules'));
assert.equal(run('--apply').status,0);assert.equal(fs.readFileSync(path.join(target,'test.txt'),'utf8'),'public');
assert.equal(fs.existsSync(path.join(target,'runtime/docs/node_modules')),false);
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target,'settings.json'))),{});
assert.equal(fs.statSync(path.join(target,'models.json')).mode & 0o777,0o600);
for (const dir of ['extensions','npm']) assert.equal(fs.readlinkSync(path.join(target,dir,'node_modules')),'../runtime/node_modules');
assert.equal(JSON.parse(fs.readFileSync(path.join(target,'runtime/core/coding-agent/package.json'))).name,'@yunuspi/coding-agent');
assert.equal(fs.readlinkSync(path.join(target,'bin/pi')),'yunuspi');
assert.equal(fs.readFileSync(path.join(target,'runtime/docs/INSTALL.md'),'utf8'),'YunusPi source installation');
assert.equal(fs.readFileSync(path.join(target,'runtime/AGENTS.md'),'utf8'),'Owned-source development');
assert.equal(fs.readFileSync(path.join(target,'runtime/release-template/docs/INSTALL.md'),'utf8'),'YunusPi source installation');
assert.equal(fs.readFileSync(path.join(target,'runtime/release-template/scripts/install.mjs'),'utf8'),fs.readFileSync(script,'utf8'));
assert.match(fs.readFileSync(path.join(target,'runtime/.npmrc'),'utf8'),/^ignore-scripts=true/m);
const unbuilt=spawnSync(path.join(target,'bin/yunuspi'),['--version'],{encoding:'utf8'});assert.notEqual(unbuilt.status,0);assert.match(unbuilt.stderr,/not built/);
fs.writeFileSync(path.join(target,'private.txt'),'fixture-only');
assert.notEqual(run('--apply').status,0);assert(fs.existsSync(path.join(target,'private.txt')));
assert.equal(run('--apply','--backup-existing','--offline').status,0);assert(!fs.existsSync(path.join(target,'private.txt')));
const calls=fs.readFileSync(path.join(root,'npm.log'),'utf8').trim().split('\n').map(JSON.parse);
assert.deepEqual(calls,[['ci','--ignore-scripts','--no-audit','--no-fund','--offline'],['run','build:core']]);
const launched=spawnSync(path.join(target,'bin/yunuspi'),['--version'],{encoding:'utf8'});assert.equal(launched.status,0,launched.stderr);assert.match(launched.stdout,/YunusPi fixture/);
fs.writeFileSync(path.join(target,'runtime/core/coding-agent/dist/cli.js'),'console.log(JSON.stringify(process.argv.slice(2)));');
const modelUpdate=spawnSync(path.join(target,'bin/yunuspi'),['update','--models'],{encoding:'utf8'});
assert.equal(modelUpdate.status,0,modelUpdate.stderr);assert.match(modelUpdate.stdout,/\["update","--models"\]/);
const privateModel=path.join(target,'local-models','fixture','venv','bin');fs.mkdirSync(privateModel,{recursive:true});fs.writeFileSync(path.join(privateModel,'python3.12'),'fixture-interpreter');
const injectMove=spawnSync(process.execPath,[script,'--target',target,'--skip-needle','--apply','--backup-existing','--preserve-state','--offline'],{encoding:'utf8',env:{...env,NODE_ENV:'test',YUNUSPI_TEST_FAIL_AFTER_STATE_MOVE:'1'}});
assert.notEqual(injectMove.status,0);assert.match(injectMove.stderr,/Injected activation failure/);assert.equal(fs.readFileSync(path.join(target,'local-models/fixture/venv/bin/python3.12'),'utf8'),'fixture-interpreter');assert.equal(fs.readdirSync(root).some(name=>name.startsWith('.yunuspi-install-')),false);
const injectRollback=spawnSync(process.execPath,[script,'--target',target,'--skip-needle','--apply','--backup-existing','--preserve-state','--offline'],{encoding:'utf8',env:{...env,NODE_ENV:'test',YUNUSPI_TEST_FAIL_AFTER_STATE_MOVE:'1',YUNUSPI_TEST_FAIL_STATE_ROLLBACK:'1'}});
assert.notEqual(injectRollback.status,0);assert.match(injectRollback.stderr,/staged data retained/);assert(fs.readdirSync(root).some(name=>name.startsWith('.yunuspi-install-')));
const failedBuild=spawnSync(process.execPath,[script,'--target',target,'--skip-needle','--apply','--backup-existing','--offline'],{encoding:'utf8',env:{...env,YUNUSPI_TEST_BUILD_FAIL:'1'}});
assert.notEqual(failedBuild.status,0);assert.match(failedBuild.stderr,/Owned core build failed/);assert(fs.existsSync(path.join(target,'runtime/core/coding-agent/dist/cli.js')));
const backup=fs.readdirSync(root).find(x=>x.startsWith('target.backup-'));assert(backup);assert.equal(fs.readFileSync(path.join(root,backup,'private.txt'),'utf8'),'fixture-only');
assert.notEqual(run('--bad').status,0);
fs.symlinkSync('/tmp',path.join(repo,'agent','unsafe-link'));assert.notEqual(run('--apply','--backup-existing').status,0);fs.unlinkSync(path.join(repo,'agent','unsafe-link'));
for (const name of ['agent','core','docs']) {
 const actual=path.join(repo,name), outside=path.join(root,`outside-${name}`);
 fs.renameSync(actual,outside);fs.symlinkSync(outside,actual);
 try { const linked=run('--apply','--backup-existing');assert.notEqual(linked.status,0);assert.match(linked.stderr,/Source root must be a regular directory/); }
 finally { fs.unlinkSync(actual);fs.renameSync(outside,actual); }
}
assert.notEqual(spawnSync(process.execPath,[script,'--target',path.join(repo,'nested')],{encoding:'utf8'}).status,0);
const symlinkTarget=path.join(root,'link');fs.symlinkSync(target,symlinkTarget);assert.notEqual(spawnSync(process.execPath,[script,'--apply','--backup-existing','--target',symlinkTarget],{encoding:'utf8'}).status,0);
const lease=spawn('flock',['--shared',path.join(target,'logs/harness-session.lock'),'/bin/bash','-c','printf ready; read -r done'],{stdio:['pipe','pipe','pipe']});
await new Promise((resolve,reject)=>{lease.stdout.once('data',resolve);lease.once('error',reject);});
try { const busy=run('--apply','--backup-existing');assert.equal(busy.status,75,busy.stderr);assert(fs.existsSync(path.join(target,'runtime/core/coding-agent/dist/cli.js'))); }
finally { lease.stdin.end('done\n'); }
console.log('installer checks passed: owned-source preview/build/launcher, offline npm, backups, active-session refusal, and path safety');
}finally{fs.rmSync(root,{recursive:true,force:true});}
