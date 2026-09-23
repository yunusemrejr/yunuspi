import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const tree=path.resolve(import.meta.dirname,'..');
const agent=[path.join(tree,'agent'),path.resolve(tree,'..')].find(p=>fs.existsSync(path.join(p,'extensions/utility-tools.ts')));
const load=name=>import(pathToFileURL(path.join(agent,'extensions',name)));
const {UtilityClient}=await load('lib/utility-client.ts');
const {matrixSummary}=await load('lib/utility-mcp/workflow.mjs');
const {serviceProbe}=await load('lib/service-probe.ts');
const {default:registerSys}=await load('sys-probe.ts');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'yunuspi-developer-'));
const outside=fs.mkdtempSync(path.join(os.tmpdir(),'yunuspi-outside-'));
const client=new UtilityClient(root);
after(()=>{client.close();fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});});
const write=(name,text)=>{const target=path.join(root,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);};
const call=async(name,args,isError=false)=>{const result=await client.call(name,args);assert.equal(result.isError,isError,JSON.stringify(result));assert.ok(Buffer.byteLength(result.content[0].text)<=24576);return JSON.parse(result.content[0].text);};

test('native workflow tool parses jobs, exact literal matrices, local references and source locations without executable values',async()=>{
 write('actions/setup/action.yml','runs: {using: composite, steps: [{run: NEVER_EXECUTE_WORKFLOW_CANARY}]}');
 write('.github/workflows/reuse.yml','on: workflow_call\njobs: {}');
 write('.github/workflows/check.yml',`on: [push, pull_request]
env: {PRIVATE: NEVER_EXPOSE_WORKFLOW_CANARY}
jobs:
  build:
    strategy:
      matrix:
        os: [linux, windows]
        node: [20, 22]
        exclude: [{os: windows, node: 20}]
        include: [{extra: value}, {os: other, node: 24}]
    steps:
      - uses: ./actions/setup
      - run: echo NEVER_EXECUTE_WORKFLOW_CANARY
      - uses: actions/checkout@v4
  test:
    needs: build
    uses: ./.github/workflows/reuse.yml
`);
 const result=await call('workflow_probe',{path:'.github/workflows/check.yml'});
 assert.deepEqual(result.triggers,['push','pull_request']);assert.equal(result.items[0].matrix.combinations,4);
 assert.equal(result.items[0].line,5);assert.deepEqual(result.topological_order,['build','test']);
 assert.deepEqual(result.items[0].uses.map(row=>row.status),['present','not-fetched']);
 assert.equal(result.items[1].uses[0].kind,'local-workflow');assert.equal(result.items[1].uses[0].status,'present');
 assert.equal(result.findings.length,0);assert.match(result.input_hash,/^[a-f0-9]{64}$/);
 assert.doesNotMatch(JSON.stringify(result),/NEVER_|\bextra\b/);
 const page=await call('workflow_probe',{path:'.github/workflows/check.yml',limit:1,offset:1});assert.equal(page.items[0].id,'test');assert.equal(page.total,2);
});

test('workflow graph reports cycles, unknown needs and unresolved matrices without inventing evaluation',async()=>{
 write('bad.yml',`on: push
jobs:
  first:
    needs: [second, absent]
    strategy: {matrix: '\${{ fromJSON(needs.secret.outputs.value) }}'}
    steps: [{uses: ./actions/missing}]
  second:
    needs: first
    steps: [{uses: ../not-a-local-action}]
`);
 const result=await call('workflow_probe',{path:'bad.yml'});
 assert.equal(result.topological_order,null);assert.equal(result.cycles.length,1);
 assert.ok(result.findings.some(row=>row.code==='unknown-needed-job'));
 assert.ok(result.findings.some(row=>row.code==='local-use-missing'));
 assert.equal(result.items[0].matrix.status,'unresolved');assert.equal(result.items[0].matrix.combinations,undefined);
 assert.doesNotMatch(JSON.stringify(result),/secret.outputs/);
 assert.equal(matrixSummary({include:[{os:'linux'},{os:'windows'}]}).combinations,2);
 assert.equal(matrixSummary({os:['a','b'],include:[{x:1},{x:2}]}).combinations,2);
 assert.equal(matrixSummary({os:['a'],exclude:[{os:'a'}],include:[{os:'a'}]}).combinations,1);
 assert.equal(matrixSummary({x:Array(100).fill(1),y:Array(100).fill(1)}).status,'limit');
 assert.equal(matrixSummary({x:[]}).status,'invalid');
 assert.equal(matrixSummary({}).status,'invalid');
 assert.equal(matrixSummary({x:[1],include:null}).status,'invalid');
 assert.equal(matrixSummary({x:[{name:'one'}]}).status,'unresolved');
});

test('workflow malformed YAML, alias abuse, paths and limits stay bounded; reference changes invalidate hash',async()=>{
 write('duplicate.yml','jobs:\n  first: {}\n  first: {run: NEVER_EXPOSE_PARSE_CANARY}\n');
 const invalid=await call('workflow_probe',{path:'duplicate.yml'});
 assert.equal(invalid.parsed,false);assert.equal(invalid.findings[0].line,3);assert.doesNotMatch(JSON.stringify(invalid),/CANARY/);
 write('escape.yml','jobs:\n  build:\n    steps: [{uses: ./outside}]\n');fs.symlinkSync(outside,path.join(root,'outside'));
 const escaped=await call('workflow_probe',{path:'escape.yml'});assert.equal(escaped.items[0].uses[0].status,'outside-root');
 await call('workflow_probe',{path:'outside/secret.yml'},true);
 write('huge.yml','#'+'x'.repeat(512*1024));await call('workflow_probe',{path:'huge.yml'},true);
 write('many.yml','jobs:\n'+Array.from({length:201},(_,i)=>`  job${i}: {}`).join('\n'));await call('workflow_probe',{path:'many.yml'},true);
 write('local.yml','jobs:\n  build:\n    steps: [{uses: ./future}]\n');
 const before=await call('workflow_probe',{path:'local.yml'});write('future/action.yaml','name: fixture');
 const after=await call('workflow_probe',{path:'local.yml'});assert.notEqual(before.input_hash,after.input_hash);assert.equal(after.items[0].uses[0].status,'present');
 await call('workflow_probe',{path:'local.yml',execute:true},true);
});

test('web asset tool resolves explicit HTML/CSS/manifest and hosted base paths with private queries omitted',async()=>{
 write('public/assets/Logo.svg','<svg/>');write('public/app.js','throw new Error("NEVER_EXECUTE_ASSET_CANARY")');
 write('public/style.css','/* url(ignored.png) */\n@import "theme.css";\n.logo{background:url("assets/Logo.svg")}\n.x{content:"url(ignored2.png)"}');
 write('public/theme.css','body {}');write('public/app.webmanifest',JSON.stringify({icons:[{src:'assets/Logo.svg'}]}));
 const syntheticUrl=new URL('https://example.test/a.png');syntheticUrl.username='user';syntheticUrl.password='NEVER_EXPOSE_ASSET_CANARY';syntheticUrl.searchParams.set('token','NEVER_EXPOSE_ASSET_CANARY');
 write('public/index.html',`<!doctype html>
<base href="/app/nested/">
<script src="../app.js"></script>
<link rel="stylesheet" href="../style.css">
<img src="../assets/logo.svg?token=NEVER_EXPOSE_ASSET_CANARY">
<img src="../missing.png">
<img src="${syntheticUrl}">
<img src="\${computed}"><img srcset="../assets/Logo.svg 1x, ../missing2.png 2x">
<style>.picture { background: url('../assets/Logo.svg') }</style>
`);
 const result=await call('web_asset_check',{files:['public/index.html','public/style.css','public/app.webmanifest'],asset_root:'public',public_path:'/app/'});
 assert.equal(result.counts['case-mismatch'],1);assert.equal(result.counts.missing,2);assert.equal(result.counts.external,1);assert.equal(result.counts.unresolved,1);
 assert.ok(result.counts.present>=6);assert.equal(result.items.find(row=>row.status==='case-mismatch').line,5);
 assert.ok(!result.items.some(row=>row.reference?.includes('ignored')));assert.doesNotMatch(JSON.stringify(result),/CANARY|user:|token=|computed/);
 const page=await call('web_asset_check',{files:['public/index.html'],asset_root:'public',public_path:'/app/',limit:2});assert.equal(page.items.length,2);assert.equal(page.next_offset,2);
});

test('asset checker refuses escapes, preserves unknown bases and reports exact existence changes',async()=>{
 write('public/escape.html','<img src="outside/file.png"><img src="%2e%2e/outside/file.png"><img src="/different/file.png">');
 fs.symlinkSync(outside,path.join(root,'public/outside'));
 const result=await call('web_asset_check',{files:['public/escape.html'],asset_root:'public',public_path:'/app/'});
 assert.deepEqual(result.items.map(row=>row.status),['outside-root','outside-public-path','outside-public-path']);
 write('public/base.html','<base href="${runtime}"><img src="logo.svg">');assert.equal((await call('web_asset_check',{files:['public/base.html'],asset_root:'public'})).items[0].status,'unresolved');
 write('public/external.html','<base href="https://example.test/"><img src="x.png">');assert.equal((await call('web_asset_check',{files:['public/external.html'],asset_root:'public'})).items[0].status,'external');
 write('public/reserved.html','<img src="https://assets.invalid/secret.png"><img src="//assets.invalid/secret.png">');assert.deepEqual((await call('web_asset_check',{files:['public/reserved.html']})).items.map(row=>row.status),['external','external']);
 write('public/reserved-base.html','<base href="https://assets.invalid/"><img src="secret.png">');assert.equal((await call('web_asset_check',{files:['public/reserved-base.html']})).items[0].status,'external');
 for(const css of ['a { background:url(unfinished', '/* unfinished', 'a { content:"unfinished']){write('public/malformed.css',css);await call('web_asset_check',{files:['public/malformed.css']},true);}
 write('public/broken.webmanifest','{"icons": ');await call('web_asset_check',{files:['public/broken.webmanifest']},true);
 await call('web_asset_check',{files:['public/index.html'],asset_root:'public',public_path:'/../'},true);
 await call('web_asset_check',{files:['local.yml'],asset_root:'public'},true);
 write('public/future.html','<img src="future.svg">');const before=await call('web_asset_check',{files:['public/future.html']});write('public/future.svg','<svg/>');const after=await call('web_asset_check',{files:['public/future.html']});assert.notEqual(before.input_hash,after.input_hash);
 write('public/overflow.html','<img src="x">'.repeat(2001));await call('web_asset_check',{files:['public/overflow.html']},true);
});

test('service detail uses fixed inspection flags and omits commands, environment and unexpected fields',async()=>{
 let called;
 const result=await serviceProbe('service_detail',20,{unit:'example.service'},undefined,async(binary,args)=>{called={binary,args};return 'Id=example.service\nLoadState=loaded\nActiveState=failed\nMainPID=42\nExecMainStatus=1\nEnvironment=NEVER_EXPOSE_SYSTEM_CANARY\nExecStart=NEVER_EXECUTE_SYSTEM_CANARY\nDescription=NEVER_EXPOSE_SYSTEM_CANARY\n';});
 assert.equal(called.binary,'/usr/bin/systemctl');assert.deepEqual(called.args.slice(-2),['--','example.service']);assert.equal(called.args[0],'show');
 assert.equal(result.rows[0].MainPID,42);assert.equal(result.rows[0].ActiveState,'failed');assert.doesNotMatch(JSON.stringify(result),/CANARY/);
 for(const unit of ['--all','*.service','../a.service','a.service;id','a.service\nnext'])await assert.rejects(serviceProbe('service_detail',1,{unit},undefined,async()=>{assert.fail('must not launch');}));
 await assert.rejects(serviceProbe('journal',1,{unit:'example.service',cursor:'s=1\n--all'},undefined,async()=>{assert.fail('must not launch');}));
});

test('journal metadata uses forward cursor pages and never returns body or host fields',async()=>{
 const rows=[1,2,3].map(i=>({__CURSOR:`s=fixture;i=${i}`,__REALTIME_TIMESTAMP:String(100+i),PRIORITY:'3',_PID:'42',_SYSTEMD_UNIT:'example.service',MESSAGE:'NEVER_EXPOSE_JOURNAL_CANARY',_HOSTNAME:'NEVER_EXPOSE_HOST_CANARY'}));
 let args;
 const first=await serviceProbe('journal',2,{unit:'example.service'},undefined,async(_binary,value)=>{args=value;return rows.map(row=>JSON.stringify(row)).join('\n');});
 assert.equal(first.rows.length,2);assert.equal(first.truncated,true);assert.equal(first.next_cursor,'s=fixture;i=2');assert.ok(args.includes('--lines=+3'));assert.ok(args.includes('--since=-3600 seconds'));
 assert.doesNotMatch(JSON.stringify(first),/CANARY/);assert.doesNotMatch(JSON.stringify(first.rows),/MESSAGE|HOSTNAME/);
 const next=await serviceProbe('journal',2,{unit:'example.service',cursor:first.next_cursor,user:true},undefined,async(_binary,value)=>{args=value;return JSON.stringify(rows[2]);});
 assert.equal(next.truncated,false);assert.equal(next.next_cursor,'s=fixture;i=3');assert.ok(args.includes('--after-cursor=s=fixture;i=2'));assert.ok(args.includes('--user-unit=example.service'));assert.ok(!args.some(a=>a.startsWith('--since')));
 await assert.rejects(serviceProbe('journal',2,{unit:'example.service'},undefined,async()=>JSON.stringify({MESSAGE:'not a receipt'})),/cursor/);
 await assert.rejects(serviceProbe('journal',2,{unit:'example.service'},AbortSignal.abort(),async()=>{assert.fail('cancelled before dispatch');}));
});

test('native sys tool exposes and validates both new actions',async()=>{
 let tool;registerSys({registerTool:value=>{tool=value;}});
 assert.ok(tool.parameters.properties.action.anyOf.some(row=>row.const==='service_detail'));
 assert.ok(tool.parameters.properties.action.anyOf.some(row=>row.const==='journal'));
 const invalid=await tool.execute('fixture',{action:'journal',unit:'--all'});assert.equal(invalid.isError,true);
 const wrong=await tool.execute('fixture',{action:'host',unit:'example.service'});assert.equal(wrong.isError,true);
});


test('local Actions require metadata and reusable workflow references use the supported directory',async()=>{
 write('container-only/Dockerfile','FROM scratch');write('reuse.yml','on: workflow_call\njobs: {}');
 write('.github/workflows/nested/reuse.yml','on: workflow_call\njobs: {}');
 write('action-locations.yml',`jobs:
  build:
    steps: [{uses: ./container-only}]
  wrong_root:
    uses: ./reuse.yml
  nested:
    uses: ./.github/workflows/nested/reuse.yml
  bound_repository:
    uses: $/.github/workflows/reuse.yml
`);
 const result=await call('workflow_probe',{path:'action-locations.yml'});
 assert.equal(result.items[0].uses[0].status,'missing-action-definition');
 assert.deepEqual(result.items.slice(1,3).map(job=>job.uses[0].status),['unsupported-workflow-location','unsupported-workflow-location']);
 assert.equal(result.items[3].uses[0].status,'unresolved');
 write('container-only/action.yml','runs: {using: docker, image: Dockerfile}');
 assert.equal((await call('workflow_probe',{path:'action-locations.yml'})).items[0].uses[0].status,'present');
});
