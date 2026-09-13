// Display-only branding. APP_NAME, command names, paths and package identity stay upstream.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const marker = 'PI_TUI_BRANDING_V1';
export const previousLogo = `theme.fg("accent", /* ${marker} */ "Yunus Pi")`;
const rat = ["   (\\_/)", "   (o.o)____", "  / >o<    \\__", "  \\________/~~~~"].join("\n");
export const previousRatLogo = `(/* PI_RAT_MASCOT_V1 */ theme.fg("accent", ${JSON.stringify(rat.split("\n").slice(0,3).join("\n"))}) + "\\n" + theme.fg("success", ${JSON.stringify(rat.split("\n")[3])}) + "\\n" + ${previousLogo})`;
// Side profile: round ears, pointed nose, haunches and a long curling tail.
const ratBody = [
  '       ()()_.-"""-.',
  "       (..)'       `.",
  '       /             \\',
  '      o_  /   (       )__',
].join("\n");
export const previousSideRatLogo = `(/* PI_RAT_MASCOT_V2 */ theme.fg("accent", ${JSON.stringify(ratBody)}) + "\\n" + theme.fg("accent", ${JSON.stringify("        `-.___ \\     /")}) + theme.fg("warning", ${JSON.stringify("   `---...___")}) + "\\n" + theme.fg("accent", ${JSON.stringify("           c_c_/-..-'")}) + theme.fg("warning", ${JSON.stringify("             `)")}) + "\\n" + ${previousLogo})`;
// One attached traveling curve; only the anatomical attachment remains stationary.
const previousAnimatedFrame = "function renderRatFrame(theme, frame = 0) {\n  const index = ((Math.trunc(frame) % 6) + 6) % 6;\n  const ears = ['()()', '()<>', '<>()', '()()', '<>()', '()<>' ][index];\n  const tails = [\n    ['   `---...___', '             `)'],\n    ['   `--..__   ', '          `---)'],\n    ['    __..---. ', '   `        _)'],\n    ['   .---..__  ', '   `       `-)'],\n    ['   `--..___  ', '           `-)'],\n    ['   `---..___ ', '            `)'],\n  ][index];\n  const color = ['warning', 'accent', 'success', 'accent', 'warning', 'success'][index];\n  const lines = [\n    `       ${ears}_.-\"\"\"-.`, \"       (..)'       `.\",\n    '       /             \\\\', '      o_  /   (       )__',\n    '        `-.___ \\\\     /', \"           c_c_/-..-'\",\n  ];\n  return lines.map((line, i) => theme.fg('accent', line) +\n    (i >= 4 ? theme.fg(color, tails[i-4].padEnd(36-line.length)) : ' '.repeat(Math.max(0, 36-line.length)))).join('\\n');\n}";
export const previousAnimatedRatLogo = `(/* PI_RAT_MASCOT_V3 */ (${previousAnimatedFrame})(theme, this._yunusRatFrame ?? 0) + "\\n" + ${previousLogo})`;
export function renderRatFrame(theme, frame = 0) {
  const index = ((Math.trunc(Number.isFinite(frame) ? frame : 0) % 16) + 16) % 16;
  const ears = index === 3 || index === 4 ? '()<>' : index === 11 || index === 12 ? '<>()' : '()()';
  const lines = [
    `       ${ears}_.-"""-.`, "       (..)'       `.",
    '       /             \\', '      o_  /   (       )',
    '        `-.___ \\     /', "           c_c_/-..-'",
  ].map(line => line.padEnd(36).split(''));
  const phase = index * Math.PI / 8;
  const colors = ['warning', 'accent', 'success', 'accent'];
  const tail = Array.from({length: 6}, () => new Set());
  let previousY = 3;
  for (let x = 23; x < 36; x++) {
    const t = (x - 22) / 13;
    const y = Math.max(2, Math.min(5, Math.round(3 + 0.6 * t + 1.25 * Math.sqrt(t) * Math.sin(phase - 2 * t))));
    const drawY = y < previousY ? previousY : y;
    lines[drawY][x] = y < previousY ? '/' : y > previousY ? '\\' : '_';
    tail[drawY].add(x);
    previousY = y;
  }
  return lines.map((line, y) => {
    let output = '', run = '', currentColor;
    for (let x = 0; x < line.length; x++) {
      const color = tail[y].has(x) ? colors[(Math.floor(index / 2) + Math.floor((x - 23) / 4)) % 4] : 'accent';
      if (currentColor !== color && run) { output += theme.fg(currentColor, run); run = ''; }
      currentColor = color; run += line[x];
    }
    return output + theme.fg(currentColor, run);
  }).join('\n');
}
export const brandedLogo = `(/* PI_RAT_MASCOT_V4 */ (${renderRatFrame.toString()})(theme, this._yunusRatFrame ?? 0) + "\\n" + ${previousLogo})`;

export function startRatMotion(owner) {
  owner._yunusRatDispose?.();
  owner._yunusRatFrame = 0;
  if (process.env.PI_RAT_ANIMATION === 'off' || process.env.TERM === 'dumb') return;
  const started = Date.now();
  const timer = setInterval(() => {
    if (!owner.isInitialized || owner.customHeader || !owner.builtInHeader?.setExpanded) return;
    // The startup mascot is above the conversation. Stop repainting it once
    // chat begins; it remains a static part of scrollback, not a busy loop.
    if (owner.chatContainer?.children?.length) { owner._yunusRatDispose?.(); return; }
    // Once the header leaves the viewport, changing it forces a full redraw.
    // Splitting a terminal for another session can trigger this while idle.
    const terminal = owner.ui.terminal;
    if (terminal && owner.ui.render(terminal.columns).length > terminal.rows) {
      owner._yunusRatDispose?.();
      return;
    }
    owner._yunusRatFrame = Math.floor((Date.now() - started) / 100) % 16;
    owner.builtInHeader.setExpanded(owner.getStartupExpansionState());
    owner.ui.requestRender();
  }, 100);
  timer.unref?.();
  owner._yunusRatDispose = () => { clearInterval(timer); owner._yunusRatDispose = undefined; };
}
const previousMotionInstallV2 = "(/* PI_RAT_MOTION_V2 */ (function startRatMotion(owner) {\n  owner._yunusRatDispose?.();\n  owner._yunusRatFrame = 0;\n  if (process.env.PI_RAT_ANIMATION === 'off' || process.env.TERM === 'dumb') return;\n  const started = Date.now();\n  const timer = setInterval(() => {\n    if (!owner.isInitialized || owner.customHeader || !owner.builtInHeader?.setExpanded) return;\n    // The startup mascot is above the conversation. Stop repainting it once\n    // chat begins; it remains a static part of scrollback, not a busy loop.\n    if (owner.chatContainer?.children?.length) { owner._yunusRatDispose?.(); return; }\n    owner._yunusRatFrame = Math.floor((Date.now() - started) / 100) % 16;\n    owner.builtInHeader.setExpanded(owner.getStartupExpansionState());\n    owner.ui.requestRender();\n  }, 100);\n  timer.unref?.();\n  owner._yunusRatDispose = () => { clearInterval(timer); owner._yunusRatDispose = undefined; };\n})(this))";
const previousMotionInstall = "(/* PI_RAT_MOTION_V1 */ (function startRatMotion(owner) {\n  owner._yunusRatDispose?.();\n  owner._yunusRatFrame = 0;\n  if (process.env.PI_RAT_ANIMATION === 'off' || process.env.TERM === 'dumb') return;\n  const started = Date.now();\n  const timer = setInterval(() => {\n    if (!owner.isInitialized || owner.customHeader || !owner.builtInHeader?.setExpanded) return;\n    // The startup mascot is above the conversation. Stop repainting it once\n    // chat begins; it remains a static part of scrollback, not a busy loop.\n    if (owner.chatContainer?.children?.length) { owner._yunusRatDispose?.(); return; }\n    owner._yunusRatFrame = Math.floor((Date.now() - started) / 240) % 6;\n    owner.builtInHeader.setExpanded(owner.getStartupExpansionState());\n    owner.ui.requestRender();\n  }, 240);\n  timer.unref?.();\n  owner._yunusRatDispose = () => { clearInterval(timer); owner._yunusRatDispose = undefined; };\n})(this))";
const motionInstall = `(/* PI_RAT_MOTION_V3 */ (${startRatMotion.toString()})(this))`;
const cleanup = 'this._yunusRatDispose?.(),';
const count = (s, needle) => s.split(needle).length - 1;
export function transformBranding(source, bundled = false) {
  const oldLogo = bundled ? 'theme.fg("accent",APP_NAME)' : 'theme.fg("accent", APP_NAME)';
  for (const [tag, old] of [['PI_RAT_MASCOT_V1', previousRatLogo], ['PI_RAT_MASCOT_V2', previousSideRatLogo], ['PI_RAT_MASCOT_V3', previousAnimatedRatLogo]]) {
    if (source.includes(tag)) {
      if (count(source, old) !== 1) throw Error('tui-branding: prior rat drift');
      source = source.replace(old, () => brandedLogo);
    }
  }
  if (source.includes(marker) && !source.includes('PI_RAT_MASCOT_V4')) {
    if (count(source,previousLogo)!==1) throw Error('tui-branding: prior logo drift');
    source=source.replace(previousLogo,()=>brandedLogo);
  }
  const edits = [[oldLogo, brandedLogo, 1], ['` v${this.version}`', '` v${this.version}\\ncustomized Pi Harness`', 1], ['${APP_TITLE} - ', 'Yunus Pi - ', 2]];
  if (!source.includes(marker)) {
    for (const [before, after, n] of edits)
      if (count(source,before)!==n || source.includes(after)) throw Error('tui-branding: upstream display anchor drift');
    for (const [before, after] of edits) source=source.split(before).join(after);
  }
  for (const [before,after,n] of edits)
    if (count(source,after)!==n || source.includes(before)) throw Error('tui-branding: partial patch or display drift');
  const header = bundled ? 'this.builtInHeader=new ExpandableText(' : 'this.builtInHeader = new ExpandableText(';
  const logoDeclaration = bundled ? 'logo=theme.bold(' : 'logo = theme.bold(';
  const animatedDeclaration = bundled ? 'logo=()=>theme.bold(' : 'logo = () => theme.bold(';
  const stop = bundled ? 'stop(fullscreenExitOutput=this.settingsManager.getFullscreenExitOutput()){' : 'stop(fullscreenExitOutput = this.settingsManager.getFullscreenExitOutput()) {';
  if (source.includes('PI_RAT_MOTION_V1')) {
    if (count(source,previousMotionInstall)!==1) throw Error('tui-branding: prior motion drift');
    source=source.replace(previousMotionInstall,()=>motionInstall);
  }
  if (source.includes('PI_RAT_MOTION_V2')) {
    if (count(source,previousMotionInstallV2)!==1) throw Error('tui-branding: prior motion drift');
    source=source.replace(previousMotionInstallV2,()=>motionInstall);
  }
  if (!source.includes('PI_RAT_MOTION_V3')) {
    if (count(source,header)!==1 || count(source,logoDeclaration)!==1 || count(source,'${logo}')!==2 || count(source,stop)!==1) throw Error('tui-branding: animation anchor drift');
    source=source.replace(logoDeclaration,animatedDeclaration).replaceAll('${logo}','${logo()}')
      .replace(header,()=>motionInstall+','+header).replace(stop,stop+cleanup);
  }
  if (count(source,motionInstall)!==1 || count(source,animatedDeclaration)!==1 || count(source,'${logo()}')!==2 || count(source,stop+cleanup)!==1) throw Error('tui-branding: animation drift');
  return source;
}
export function targets() {
  const core = process.env.PI_HARNESS_PATCH_TEST_CORE ?? path.join(execFileSync('npm', ['root', '-g'], {encoding:'utf8'}).trim(), '@earendil-works/pi-coding-agent');
  const sdk = path.join(core, 'dist/modes/interactive/interactive-mode.js');
  const bundle = path.join(core, 'dist/bundle');
  const owners = fs.readdirSync(bundle, {recursive:true}).filter(f => f.endsWith('.js')).map(f => path.join(bundle, f)).filter(f => {
    const s = fs.readFileSync(f, 'utf8');
    return s.includes('this.builtInHeader') && s.includes('getQuietStartup()');
  });
  if (!fs.existsSync(sdk) || owners.length !== 1) throw Error('tui-branding: required SDK/unique CLI owner missing');
  const definitions = [[sdk, false], [owners[0], true]];
  return definitions.map(([file, bundled]) => ({
    name: `TUI display branding: ${path.relative(core, file)}`, file,
    exists: () => fs.existsSync(file),
    isApplied() { const s = fs.readFileSync(file, 'utf8'); return s.includes(marker) && transformBranding(s, bundled) === s; },
    apply() {
      // Validate every entry point before touching either; updates fail visibly on unknown layouts.
      for (const [target, minified] of definitions) {
        const next = transformBranding(fs.readFileSync(target, 'utf8'), minified);
        execFileSync(process.execPath, ['--input-type=module', '--check'], {input:next, stdio:['pipe','pipe','pipe']});
      }
      const source = fs.readFileSync(file, 'utf8'), next = transformBranding(source, bundled);
      if (source === next) return;
      const temp = `${file}.yunus-${process.pid}.tmp`;
      try { fs.writeFileSync(temp, next, {mode:fs.statSync(file).mode & 0o777}); fs.renameSync(temp, file); }
      finally { fs.rmSync(temp, {force:true}); }
    },
  }));
}
