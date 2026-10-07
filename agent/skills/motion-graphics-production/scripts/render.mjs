#!/usr/bin/env node
// Deterministic local HTML -> PNG frames -> MP4. No browser/model installation.
//   render.mjs INPUT.html EXISTING_OUTPUT_DIR [SECONDS FPS WIDTH HEIGHT] [--alpha] [--audio=FILE] [--props=FILE.json] [--from=S] [--to=S] [--dpr=N]
// --alpha   transparent page background: RGBA PNG frames plus motion.webm (VP9 with alpha) for compositing
// --audio   mux one audio file (AAC) into the MP4, cut to the rendered duration
// --props   JSON exposed to the page as window.__PROPS__ before any script runs (colors, text, data paths)
// --from/--to   render a seconds range of the timeline; frame numbers stay global so ranges line up
// --dpr     device pixel ratio 1..3 (a 960x540 viewport at 2 writes crisp 1920x1080 frames)
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const raw=process.argv.slice(2);
const flags=new Map(raw.filter(a=>a.startsWith('--')).map(a=>{const i=a.indexOf('=');return i<0?[a.slice(2),true]:[a.slice(2,i),a.slice(i+1)];}));
const [input,parent,secondsArg='6',fpsArg='30',widthArg='1280',heightArg='720',...extra]=raw.filter(a=>!a.startsWith('--'));
const known=new Set(['alpha','audio','props','from','to','dpr']);
const unknown=[...flags.keys()].filter(k=>!known.has(k));
if(!input||!parent||extra.length||unknown.length) throw Error(`Usage: render.mjs INPUT.html EXISTING_OUTPUT_DIR [SECONDS FPS WIDTH HEIGHT] [--alpha] [--audio=FILE] [--props=FILE.json] [--from=S] [--to=S] [--dpr=N]${unknown.length?` (unknown: ${unknown.join(', ')})`:''}`);
const seconds=Number(secondsArg),fps=Number(fpsArg),width=Number(widthArg),height=Number(heightArg);
if(!Number.isFinite(seconds)||seconds<=0||seconds>60||!Number.isInteger(fps)||fps<1||fps>60||![width,height].every(n=>Number.isInteger(n)&&n>=64&&n<=1920&&n%2===0)) throw Error('Use 0..60 seconds, 1..60 integer FPS and even dimensions 64..1920');
const dpr=flags.has('dpr')?Number(flags.get('dpr')):1;
if(!Number.isFinite(dpr)||dpr<1||dpr>3)throw Error('--dpr must be between 1 and 3');
const total=Math.round(seconds*fps);
const first=flags.has('from')?Math.round(Number(flags.get('from'))*fps):0;
const last=flags.has('to')?Math.round(Number(flags.get('to'))*fps):total;
if(!Number.isInteger(first)||!Number.isInteger(last)||first<0||last>total||last<=first)throw Error('--from/--to must select a non-empty range inside the duration');
const count=last-first;
const alpha=flags.get('alpha')===true;
const source=await fs.realpath(input),root=await fs.realpath(parent);
if(!(await fs.stat(source)).isFile()||!(await fs.stat(root)).isDirectory())throw Error('Input must be a file and output parent an existing directory');
const side=async(name,label)=>{const file=flags.get(name);if(file===undefined)return undefined;if(typeof file!=='string'||!file)throw Error(`--${name} needs a file path`);const real=await fs.realpath(file).catch(()=>{throw Error(`${label} not found: ${file}`);});if(!(await fs.stat(real)).isFile())throw Error(`${label} must be a file`);return real;};
const audioFile=await side('audio','Audio file'),propsFile=await side('props','Props file');
const props=propsFile?JSON.parse(await fs.readFile(propsFile,'utf8')):undefined;
const require=createRequire(new URL('../../../npm/package.json',import.meta.url));
const {chromium}=require('playwright');
const output=await fs.mkdtemp(path.join(root,'motion-'));
let browser;
const started=Date.now();
try{
  // file: pages may read sibling files (data, frame sequences) but every other origin is refused below.
  browser=await chromium.launch({headless:true,args:['--allow-file-access-from-files']});
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:dpr});
  await page.route('**/*',route=>/^(?:file|data|blob):/.test(route.request().url())?route.continue():route.abort());
  if(props!==undefined)await page.addInitScript(p=>{window.__PROPS__=p;},props);
  await page.goto(pathToFileURL(source).href,{waitUntil:'load',timeout:20000});
  await page.evaluate(async()=>{await document.fonts.ready;if(typeof window.renderFrame!=='function')throw Error('Page must expose window.renderFrame(seconds)');document.body.classList.add('exporting');});
  for(let i=first;i<last;i++){
    if(Date.now()-started>600000)throw Error('Export exceeded ten-minute bound');
    await page.evaluate(async t=>{
      await window.renderFrame(t);
      // A seek can resolve before Chromium commits composited text/transform
      // layers. Flush the authored styles and wait for that paint boundary;
      // never replace the page's individual animation clocks with a new one.
      const animations=document.getAnimations();
      await Promise.all(animations.filter(a=>a.pending).map(a=>a.ready));
      for(const a of animations)if(a.effect?.target instanceof Element)void getComputedStyle(a.effect.target,a.effect.pseudoElement??null).transform;
      void document.documentElement.getBoundingClientRect();
      await new Promise(resolve=>requestAnimationFrame(resolve));
    },i/fps);
    await page.screenshot({path:path.join(output,`frame-${String(i).padStart(6,'0')}.png`),timeout:20000,omitBackground:alpha});
  }
  await browser.close();browser=undefined;
  const sequence=['-framerate',String(fps),'-start_number',String(first),'-i',path.join(output,'frame-%06d.png')];
  const encode=args=>exec('ffmpeg',['-hide_banner','-nostdin','-n','-v','error',...args],{timeout:180000,maxBuffer:1024*1024,killSignal:'SIGKILL'});
  // MP4 cannot carry alpha; an alpha render gets a VP9 WebM next to the PNG frames instead.
  const video=path.join(output,alpha?'motion.webm':'motion.mp4');
  if(alpha)await encode([...sequence,'-frames:v',String(count),'-c:v','libvpx-vp9','-pix_fmt','yuva420p','-b:v','0','-crf','24','-auto-alt-ref','0','-row-mt','1','-threads','2',video]);
  else await encode([...sequence,...(audioFile?['-i',audioFile,'-map','0:v','-map','1:a','-c:a','aac','-b:a','192k']:[]),'-frames:v',String(count),'-t',String(count/fps),'-c:v','libx264','-threads','2','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',video]);
  const manifest={source,video,frames:count,firstFrame:first,fps,width,height,dpr,alpha,audio:alpha?undefined:audioFile,requestedSeconds:seconds,renderedSeconds:count/fps,lastFrameSeconds:(last-1)/fps,frameFiles:path.join(output,'frame-%06d.png')};
  await fs.writeFile(path.join(output,'render.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(manifest,null,2));
}catch(error){
  // Keep partial frames for diagnosis or resume; no existing files are overwritten.
  console.error(`Render failed; partial artifacts retained at ${output}`);
  throw error;
}finally{if(browser)await browser.close();}
