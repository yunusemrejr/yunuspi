#!/usr/bin/env node
/** Keep the product, six owned packages, and workspace lock in one release.
 * Historical forkOrigin and third-party versions are deliberately untouched. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),versions=args.filter(a=>!a.startsWith('--')),version=versions[0];
const semver=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
if(versions.length!==1||!semver.test(version)||args.filter(a=>a==='--write').length>1||args.some(a=>a.startsWith('--')&&a!=='--write'))throw Error('Usage: node scripts/version-release.mjs X.Y.Z [--write]; defaults to a consistency check');
const read=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
const updates=new Map();
const product=read('package.json');product.version=version;updates.set('package.json',product);
const identity=read('core/identity.json');identity.version=version;updates.set('core/identity.json',identity);
const packages=fs.readdirSync(path.join(root,'core')).filter(name=>fs.existsSync(path.join(root,'core',name,'package.json'))).sort();
if(packages.length!==6)throw Error('Expected six owned core packages');
for(const name of packages){
 const file=`core/${name}/package.json`,pkg=read(file);
 if(!pkg.name.startsWith('@yunuspi/'))throw Error(`Not an owned package: ${name}`);
 pkg.version=version;
 for(const group of ['dependencies','devDependencies','optionalDependencies','peerDependencies'])for(const dep of Object.keys(pkg[group]??{}))if(dep.startsWith('@yunuspi/'))pkg[group][dep]=version;
 updates.set(file,pkg);
}
const lock=read('package-lock.json');lock.version=version;lock.packages[''].version=version;
for(const [file,pkg] of updates){if(!file.startsWith('core/')||!file.endsWith('/package.json'))continue;
 const key=path.dirname(file),entry=lock.packages[key];if(!entry)throw Error(`Workspace lock is missing ${key}`);
 entry.version=version;
 for(const group of ['dependencies','devDependencies','optionalDependencies','peerDependencies'])for(const dep of Object.keys(entry[group]??{}))if(dep.startsWith('@yunuspi/'))entry[group][dep]=version;
}
updates.set('package-lock.json',lock);
updates.set('release-template/package.json',product);updates.set('release-template/package-lock.json',lock);
// Validate all inputs, including mirrors, before changing any of them.
const mismatched=[];
for(const [file,value] of updates){
 if(JSON.stringify(read(file))!==JSON.stringify(value))mismatched.push(file);
}
if(args.includes('--write'))for(const file of mismatched)fs.writeFileSync(path.join(root,file),JSON.stringify(updates.get(file),null,2)+'\n');
console.log(JSON.stringify({version,ownedPackages:packages.length,updated:args.includes('--write')?mismatched:[],mismatched:args.includes('--write')?[]:mismatched}));
if(mismatched.length&&!args.includes('--write'))process.exitCode=1;
