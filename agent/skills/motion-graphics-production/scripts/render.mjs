#!/usr/bin/env node
// Deterministic local HTML -> PNG frames -> MP4. No browser/model installation.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const [input,parent,secondsArg='6',fpsArg='30',widthArg='1280',heightArg='720',...extra]=process.argv.slice(2);
if(!input||!parent||extra.length) throw Error('Usage: render.mjs INPUT.html EXISTING_OUTPUT_DIR [SECONDS FPS WIDTH HEIGHT]');
const seconds=Number(secondsArg),fps=Number(fpsArg),width=Number(widthArg),height=Number(heightArg);
if(!Number.isFinite(seconds)||seconds<=0||seconds>60||!Number.isInteger(fps)||fps<1||fps>60||![width,height].every(n=>Number.isInteger(n)&&n>=64&&n<=1920&&n%2===0)) throw Error('Use 0..60 seconds, 1..60 integer FPS and even dimensions 64..1920');
const count=Math.round(seconds*fps);
if(count<1)throw Error('Duration rounds to zero frames');
const source=await fs.realpath(input),root=await fs.realpath(parent);
if(!(await fs.stat(source)).isFile()||!(await fs.stat(root)).isDirectory())throw Error('Input must be a file and output parent an existing directory');
const require=createRequire(new URL('../../../npm/package.json',import.meta.url));
const {chromium}=require('playwright');
const output=await fs.mkdtemp(path.join(root,'motion-'));
let browser;
const started=Date.now();
try{
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
  await page.route('**/*',route=>/^(?:file|data|blob):/.test(route.request().url())?route.continue():route.abort());
  await page.goto(pathToFileURL(source).href,{waitUntil:'load',timeout:20000});
  await page.evaluate(async()=>{await document.fonts.ready;if(typeof window.renderFrame!=='function')throw Error('Page must expose window.renderFrame(seconds)');document.body.classList.add('exporting');});
  for(let i=0;i<count;i++){
    if(Date.now()-started>600000)throw Error('Export exceeded ten-minute bound');
    await page.evaluate(async t=>{await window.renderFrame(t);},i/fps);
    await page.screenshot({path:path.join(output,`frame-${String(i).padStart(6,'0')}.png`),timeout:20000});
  }
  await browser.close();browser=undefined;
  const video=path.join(output,'motion.mp4');
  await exec('ffmpeg',['-hide_banner','-nostdin','-n','-v','error','-framerate',String(fps),'-i',path.join(output,'frame-%06d.png'),'-frames:v',String(count),'-c:v','libx264','-threads','2','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',video],{timeout:120000,maxBuffer:1024*1024,killSignal:'SIGKILL'});
  const manifest={source,video,frames:count,fps,width,height,requestedSeconds:seconds,renderedSeconds:count/fps,lastFrameSeconds:(count-1)/fps};
  await fs.writeFile(path.join(output,'render.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(manifest,null,2));
}catch(error){
  // Keep partial frames for diagnosis or resume; no existing files are overwritten.
  console.error(`Render failed; partial artifacts retained at ${output}`);
  throw error;
}finally{if(browser)await browser.close();}
