/** Owned, guarded renderer. No generated project code executes here. */
import fs from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createAmbientFrames, skylineMask } from '../extensions/lib/ambient-frames.ts';

const request = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const { plan } = request;
const decode = async file => execFileSync('ffmpeg', ['-v', 'error', '-threads', '2', '-filter_threads', '1', '-protocol_whitelist', 'pipe', '-format_whitelist', 'png_pipe,jpeg_pipe,webp_pipe,bmp_pipe,gif,gif_pipe,tiff_pipe,qoi_pipe,pam_pipe,ppm_pipe,pgm_pipe,pbm_pipe', '-max_pixels', '40000000', '-noautorotate', '-i', 'pipe:0', '-vf', `scale=${plan.width}:${plan.height}:flags=lanczos`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { input: await fs.readFile(file), maxBuffer: plan.width * plan.height * 3 + 4096 });
const mask = request.skyMask ? await decode(request.skyMask) : plan.skyline ? skylineMask(plan.skyline,plan.width,plan.height) : undefined;
if(mask) execFileSync('ffmpeg',['-v','error','-n','-f','rawvideo','-pixel_format','rgb24','-video_size',`${plan.width}x${plan.height}`,'-i','pipe:0','-frames:v','1',request.maskOutput],{input:mask});
const frame = createAmbientFrames(await decode(request.plate), mask, plan);
const child = spawn('ffmpeg', ['-v', 'error', '-nostdin', '-n', '-threads', '2', '-filter_threads', '1', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', `${plan.width}x${plan.height}`, '-framerate', String(plan.fps), '-i', 'pipe:0',
  ...(request.audio ? ['-protocol_whitelist', 'file', '-i', request.audio] : []), '-map', '0:v:0', ...(request.audio ? ['-map', '1:a:0', '-af', `apad,atrim=duration=${plan.frames / plan.fps}`, '-c:a', 'aac', '-b:a', '192k'] : []),
  '-frames:v', String(plan.frames), '-c:v', 'libx264', '-preset', 'fast', '-crf', String(plan.crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', request.output], { stdio: ['pipe', 'ignore', 'pipe'] });
let errors = '';
child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error(`Ambient encoder exited ${code}: ${errors}`))); });
// Observe failures immediately, including before the first backpressure wait.
done.catch(() => {});
child.stdin.on('error', () => {});
try {
  for (let n = 0; n < plan.frames; n++) {
    if (child.exitCode !== null || child.stdin.destroyed) { await done; throw Error('Encoder closed before the last frame'); }
    if (!child.stdin.write(frame(n / plan.fps))) await Promise.race([once(child.stdin, 'drain'), done.then(() => { throw Error('Encoder closed while writing'); })]);
    if (n % plan.fps === 0) console.log(`AMBIENT_PROGRESS ${n}/${plan.frames}`);
  }
  child.stdin.end(); await done;
  console.log(`AMBIENT_RESULT ${JSON.stringify({ frames: plan.frames, output: request.output, colorSpace: 'RGB', camera: 'locked' })}`);
} catch (error) { child.kill('SIGKILL'); throw error; }
