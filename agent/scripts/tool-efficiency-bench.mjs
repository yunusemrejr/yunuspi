#!/usr/bin/env node
// Deterministic prompt overhead bounds; these are not model latency estimates.
import assert from 'node:assert/strict';
import {CORE_TOOLS,DIRECT_CORE_TOOLS} from '../extensions/lib/tool-discovery.ts';
import {projectTestOutput,qualityReviewOutput,testDiagnostics} from '../extensions/lib/assurance-output.ts';
for(const name of ['read','write','edit','bash','tool_search','project_tests','quality_review','bg_wait'])assert.ok(DIRECT_CORE_TOOLS.has(name));
assert.ok(DIRECT_CORE_TOOLS.size <= CORE_TOOLS.size*.7);
const findings=[{id:'blocking-1',severity:'blocking',file:'src/value.js',detail:'Concrete boundary defect.'}];
const report={aspect:'correctness',outcome:'changes',evidence:['src/value.js:4'],findings,gap:'Required boundary evidence missing.'};
const full={revision:3,changed:['src/value.js'],status:'blocked',rounds:1,limits:{rounds:2},reports:[report],truncated:true,staleReports:false,reason:'Concrete boundary defect.',scope:'Advisory source review, no synthetic correctness verdict. '.repeat(20)};
const compact=qualityReviewOutput(full,false,true);
assert.deepEqual(compact.reports[0].findings,findings);assert.equal(compact.truncated,true);assert.equal(compact.reports[0].gap,report.gap);
assert.ok(JSON.stringify(compact).length < JSON.stringify(full).length*.6);
const checks={revision:3,changed:['src/value.js'],disabled:false,paused:false,optedOut:false,need:'failed',assessment:{disposition:'required',reason:'Boundary check'},plannedChecks:[{command:'node --test',outcome:'failed',callId:'native-test',diagnostics:testDiagnostics('# tests 1\n# fail 1')}],facts:{unavailable:'bounded scan limit'},treeComplete:false};
assert.deepEqual(projectTestOutput(checks).plannedChecks,checks.plannedChecks);assert.equal(projectTestOutput(checks).facts.unavailable,checks.facts.unavailable);
console.log(JSON.stringify({kind:'deterministic overhead contract',coreToolNames:CORE_TOOLS.size,directToolNames:DIRECT_CORE_TOOLS.size,reviewFixtureChars:JSON.stringify(full).length,compactReviewFixtureChars:JSON.stringify(compact).length,requiredEvidencePreserved:true},null,2));
