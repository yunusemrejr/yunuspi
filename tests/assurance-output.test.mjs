import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname,'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..'),path.resolve(root,'../agent')].find(p=>fs.existsSync(path.join(p,'extensions/lib/assurance-output.ts')));
const {projectTestOutput,qualityReviewOutput,testDiagnostics,reviewTestContext}=await import(pathToFileURL(path.join(agent,'extensions/lib/assurance-output.ts')));
test('compact assurance retains gaps, blockers and actual commands without repeated prose or hashes',()=>{
 const report={aspect:'correctness',outcome:'changes',gap:'actual missing evidence',evidence:['src/run.js:18'],findings:[{id:'c1',severity:'blocking',file:'src/run.js',detail:'Boundary fails.'}]};
 const full={revision:7,changed:['src/run.js'],status:'blocked',rounds:1,limits:{rounds:2},reports:[report],truncated:true,staleReports:false,reason:'Current required command failed.',previousReview:{revision:6,reports:[report]},scope:'Repeated explanatory prose. '.repeat(100)};
 const out=qualityReviewOutput(full,false,true);
 assert.equal(out.revision,7);assert.equal(out.truncated,true);assert.equal(out.reason,full.reason);
 assert.deepEqual(out.reports[0].findings,report.findings);assert.equal(out.reports[0].gap,report.gap);
 assert.equal(out.previousRevision,6);assert.ok(JSON.stringify(out).length<JSON.stringify(full).length/2);
 assert.equal(qualityReviewOutput(full,true),full,'detailed view is lossless native state');
 const data={revision:7,changed:['src/run.js'],need:'failed',disabled:false,paused:false,optedOut:false,treeComplete:false,assessment:{disposition:'required',reason:'Boundary check'},plannedChecks:[{command:'node --test',outcome:'failed',callId:'native-1',diagnostics:testDiagnostics('1 test failed')}],checks:[report],tree:'immutable source hash',facts:{unavailable:'scan permission denied'}};
 const compact=projectTestOutput(data);
 assert.equal(compact.need,'failed');assert.deepEqual(compact.plannedChecks,data.plannedChecks);assert.equal(compact.facts.unavailable,'scan permission denied');assert.equal(compact.treeComplete,false);
 assert.equal(projectTestOutput(data,true),data);assert.deepEqual(reviewTestContext(data).plannedChecks,data.plannedChecks);
});
test('diagnostic captures are bounded, disclose omissions and withhold protected material',()=>{
 const text='first failure\n'+'ordinary check output '.repeat(250)+'\nlast failure';const out=testDiagnostics(text);
 assert.ok(out.text.startsWith('first failure'));assert.ok(out.text.endsWith('last failure'));assert.ok(out.text.length<1500);assert.equal(out.omitted,true);assert.equal(out.chars,text.length);
 for(const text of ['API_KEY=fixture-token','Authorization: Bearer fixture','-----BEGIN RSA ' + 'PRIVATE KEY-----','[[private]] material','{"api_key":"SYNTHETIC_TEST_CANARY"}','{"password":"SYNTHETIC_TEST_CANARY"}','{"authorization":"SYNTHETIC_TEST_CANARY"}','postgres://' + 'user:SYNTHETIC_TEST_CANARY' + '@localhost/db','redis://' + 'user:SYNTHETIC_TEST_CANARY' + '@localhost/0','<private>material</private>'])assert.match(testDiagnostics(text).text,/withheld/);
 assert.equal(testDiagnostics('   '),undefined);
});

test('independent review context redacts credentials in command labels and reasons',()=>{
 const command=['API','KEY'].join('_') + '=' + 'SYNTHETIC_TEST_CANARY node --test';
 const context=reviewTestContext({revision:2,need:null,assessment:{revision:2,disposition:'required',reason:'Connection '+ 'postgres://' + 'user:SYNTHETIC_TEST_CANARY' + '@localhost/db',checks:[{label:command}]},plannedChecks:[{command,outcome:'passed',callId:'native-1'}]});
 assert.ok(!JSON.stringify(context).includes('SYNTHETIC_TEST_CANARY'));
 assert.equal(context.plannedChecks[0].outcome,'passed');assert.equal(context.plannedChecks[0].callId,'native-1');assert.equal(context.need,null);
 assert.equal(context.assessment.checks,undefined,'do not duplicate raw native commands in delegated context');
});
