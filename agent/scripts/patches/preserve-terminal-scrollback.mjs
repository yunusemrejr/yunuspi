// Automatic regular-screen redraws must not erase the user's scrollback.
// Historical terminal rows are snapshots; the session transcript is canonical.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const marker = 'PI_PRESERVE_SCROLLBACK_V1';
const clear = [
  'output.append("\\x1b[2J\\x1b[H\\x1b[3J"); // Clear screen, home, then clear scrollback',
  'output2.append("\\x1B[2J\\x1B[H\\x1B[3J"))',
];
const nextClear = [
  'output.append("\\x1b[2J\\x1b[H"); // Preserve scrollback during automatic redraw',
  'output2.append("\\x1B[2J\\x1B[H"))',
];
const loops = [
  'for (let i = 0; i < newLines.length; i++) {\n                if (i > 0)\n                    output.append("\\r\\n");',
  'for(let i=0;i<newLines.length;i++){i>0&&output2.append(`\\r\n`);',
];
const start = `/* ${marker} */ let redrawStart = clear ? Math.max(0, newLines.length - height) : 0;
            // Include an image origin when the viewport begins in its reserved rows.
            for (let row = Math.max(0, redrawStart - height); row < redrawStart; row++) {
                if (isImageLine(newLines[row]) && row + this.getKittyImageReservedRows(newLines, row) > redrawStart) { redrawStart = row; break; }
            }
            `;
export function transformScrollback(source, bundled = false) {
  const index = bundled ? 1 : 0;
  const loop = start + (bundled
    ? 'for(let i=redrawStart;i<newLines.length;i++){i>redrawStart&&output2.append(`\\r\n`);'
    : 'for (let i = redrawStart; i < newLines.length; i++) {\n                if (i > redrawStart)\n                    output.append("\\r\\n");');
  const count = text => source.split(text).length - 1;
  if (source.includes(marker)) {
    if (count(loop) !== 1 || count(nextClear[index]) !== 1 || count(clear[index]) || count(loops[index])) throw Error('scrollback patch postcondition drift');
    return source;
  }
  if (count(clear[index]) !== 1 || count(loops[index]) !== 1) throw Error('scrollback redraw anchor drift');
  return source.replace(clear[index], () => nextClear[index]).replace(loops[index], () => loop);
}

export function targets() {
  const core = process.env.PI_HARNESS_PATCH_TEST_CORE ?? path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@earendil-works/pi-coding-agent');
  const chunks = path.join(core, 'dist/bundle/chunks');
  const owners = fs.readdirSync(chunks).filter(name => name.endsWith('.js')).map(name => path.join(chunks, name))
    .filter(file => { const source = fs.readFileSync(file, 'utf8'); return source.includes(clear[1]) || source.includes(marker); });
  if (owners.length !== 1) throw Error('scrollback patch needs exactly one bundled renderer');
  const sdk = path.join(core, 'node_modules/@earendil-works/pi-tui/dist/tui-main-screen.js');
  const specs = [[sdk, false], [owners[0], true]];
  return specs.map(([file, bundled]) => ({
    name: `preserve terminal scrollback: ${path.relative(core, file)}`, file,
    exists: () => fs.existsSync(file),
    isApplied() { const source = fs.readFileSync(file, 'utf8'); return transformScrollback(source, bundled) === source; },
    apply() {
      // Preflight both builds before writing either one.
      for (const [target, bundle] of specs) transformScrollback(fs.readFileSync(target, 'utf8'), bundle);
      const source = fs.readFileSync(file, 'utf8'), next = transformScrollback(source, bundled);
      if (source === next) return;
      execFileSync(process.execPath, ['--input-type=module', '--check'], { input: next, stdio: ['pipe', 'pipe', 'pipe'] });
      fs.writeFileSync(file, next);
    },
  }));
}
