#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {gunzipSync} from 'node:zlib';
const dir=path.join(os.homedir(),'.pi/agent/logs/health');
const args=process.argv.slice(2),raw=args.includes('--events'),filter=args.find(a=>!a.startsWith('--'))??'';
const names=fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>n.endsWith('.jsonl.gz')&&n.includes(filter)).sort().slice(-2000):[];
const counts={},errors=[];let events=0;
for(const name of names)try{
 const file=path.join(dir,name);if(fs.statSync(file).size>32*1024*1024)throw Error('segment exceeds reader limit');
 for(const line of gunzipSync(fs.readFileSync(file),{maxOutputLength:32*1024*1024}).toString().trim().split('\n'))if(line){const e=JSON.parse(line);events++;counts[e.kind]=(counts[e.kind]??0)+1;if(raw)console.log(JSON.stringify({segment:name,...e}));}
}catch(error){errors.push({segment:name,error:error.code??'invalid-or-incomplete-segment'});}
if(!raw)console.log(JSON.stringify({files:names.length,events,counts,errors},null,2));
else if(errors.length)console.error(JSON.stringify({errors}));
