import {resolveOwnedCore} from '../lib/owned-core.mjs';
// Load the complete declared main-session extension inventory against the
// installed SDK (or the candidate bound at that path). No session or inference.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const agent=fileURLToPath(new URL('../../',import.meta.url));
const manifest=JSON.parse(fs.readFileSync(path.join(agent,'extensions/manifest.json'),'utf8'));
const core=resolveOwnedCore();
const home=fs.mkdtempSync(path.join(os.tmpdir(),'pi-harness-load-'));
const paths=[...manifest.extensions,...Object.keys(manifest.forks).map(name=>path.basename(name))].map(name=>path.join(agent,'extensions',name));
try{
 const sdk=await import(pathToFileURL(path.join(core,'dist/index.js')));
 const loader=new sdk.DefaultResourceLoader({cwd:home,agentDir:home,settingsManager:sdk.SettingsManager.inMemory({packages:[],extensions:[]}),additionalExtensionPaths:paths,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});
 await loader.reload();const loaded=loader.getExtensions();
 assert.deepEqual(loaded.errors,[],'all declared extensions load against the SDK');
 // A fork directory may deliberately expose multiple entrypoints.
 assert.equal(new Set(loaded.extensions.map(extension=>extension.path)).size,loaded.extensions.length,'extension entrypoints are unique');
 for(const extension of loaded.extensions)assert.ok(paths.some(file=>extension.path===file||extension.path.startsWith(file+path.sep)),`undeclared extension: ${extension.path}`);
 for(const name of ['source_check','syntax_check','sqlite_probe','package_probe','openapi_probe','coverage_probe','contract_diff','env_audit','net_probe','archive_probe'])assert.equal(loaded.extensions.filter(extension=>extension.tools.has(name)).length,1,`${name} has one owner`);
 for(const file of paths)assert.ok(loaded.extensions.some(extension=>extension.path===file||extension.path.startsWith(file+path.sep)),file);
 console.log(`PASS complete harness SDK load: ${loaded.extensions.length} extensions/forks; no provider/session started`);
}finally{fs.rmSync(home,{recursive:true,force:true});}
