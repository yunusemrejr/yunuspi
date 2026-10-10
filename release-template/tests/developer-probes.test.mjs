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
const {serviceProbe}=await load('lib/service-probe.ts');
const {default:registerSys}=await load('sys-probe.ts');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'yunuspi-developer-'));
const outside=fs.mkdtempSync(path.join(os.tmpdir(),'yunuspi-outside-'));
const client=new UtilityClient(root);
after(()=>{client.close();fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});});
const write=(name,text)=>{const target=path.join(root,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);};
const call=async(name,args,isError=false)=>{const result=await client.call(name,args);assert.equal(result.isError,isError,JSON.stringify(result));assert.ok(Buffer.byteLength(result.content[0].text)<=24576);return JSON.parse(result.content[0].text);};

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
 assert.ok(tool.parameters.properties.action.enum.includes('service_detail'));
 assert.ok(tool.parameters.properties.action.enum.includes('journal'));
 const invalid=await tool.execute('fixture',{action:'journal',unit:'--all'});assert.equal(invalid.isError,true);
 const wrong=await tool.execute('fixture',{action:'host',unit:'example.service'});assert.equal(wrong.isError,true);
});

