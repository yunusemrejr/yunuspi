// What a composer text will do, read before it is sent: which tokens are commands,
// whether boosts chain into one goal, and what /goal will act on in this session.
// Pure: app.js supplies the session's commands, the core's token check and the goal
// status, and draws the marks and the one-line reading this returns.

/** Commands the desktop answers itself (main.mjs DESKTOP_COMMANDS); they never reach the core. */
export const LOCAL_COMMANDS = {
  model: 'Opens the model picker', models: 'Opens the model picker',
  metrics: 'Opens this session’s stats', cost: 'Opens this session’s stats', self: 'Opens this session’s stats', session: 'Opens this session’s stats',
  skills: 'Opens the command browser', tools: 'Opens the command browser', help: 'Opens the command browser',
  new: 'Starts a new session in this project', name: 'Renames this session',
};
const GOAL_WORDS = { status: 'status', show: 'status', progress: 'status', help: 'help', pause: 'pause', resume: 'resume', continue: 'resume', retry: 'retry', done: 'done', clear: 'clear', stop: 'clear' };
const PRESET_GOAL_WORDS = new Set(['status', 'help', 'pause', 'resume', 'continue', 'clear', 'stop', 'done', 'retry']);
const STATUS = { '◎': 'active', '⏸': 'paused', '⚠': 'blocked' };

/** The goal extension's status line (`goal ◎ 2/6`, see goalStatusText) as data, or null. */
export function goalFromStatus(text) {
  const match = /^goal ([◎⏸⚠]) (\d+)\/(\d+)/.exec(String(text ?? ''));
  return match ? { status: STATUS[match[1]], settled: Number(match[2]), total: Number(match[3]) } : null;
}

const progress = goal => `${goal.settled} of ${goal.total} criteria settled`;
const list = names => names.map(name => `/${name}`).join(' + ');

/**
 * `commands`: the session's commands ({ name, chainable, source, description }).
 * `check`: the core's answer for this exact text (tokens, fixes, unknown, unrecognized, terminalOnly), or undefined while it loads.
 * `goal`: goalFromStatus of the live status, or null.
 * Returns null for plain text; otherwise { marks: [{ start, end, kind }], tone: 'info'|'warn'|'error', text }.
 */
export function readCommand(text, { commands = [], check, goal = null } = {}) {
  const raw = String(text ?? '');
  const skill = /^\s*\/(skill:[\w-]+)(?=\s|$)/.exec(raw);
  if (skill) {
    const known = commands.find(c => c.name === skill[1]);
    const start = raw.indexOf('/');
    return { marks: [{ start, end: start + skill[1].length + 1, kind: known ? 'command' : 'unknown' }], tone: known ? 'info' : 'error', text: known ? `Loads the ${skill[1].slice(6)} skill guide into this session` : `/${skill[1]} is not an installed skill` };
  }
  if (!/^\s*\/[A-Za-z0-9]/.test(raw)) return null;
  const tokens = check?.tokens;
  if (!tokens?.length) return { marks: [], tone: 'info', text: 'Reading the command…' };
  const byName = new Map(commands.map(c => [c.name, c]));
  const fixes = new Map((check.fixes ?? []).map(fix => [fix.from.slice(1), fix.to]));
  const marks = tokens.map(token => ({ start: token.start, end: token.end,
    kind: fixes.has(token.name) ? 'near' : !token.known ? 'unknown' : byName.get(token.name)?.chainable ? 'boost' : 'command' }));
  const head = tokens[0], stray = check.unrecognized ?? [];
  const words = stray.length ? ` · ${stray.join(', ')} ${stray.length > 1 ? 'are not commands' : 'is not a command'}, so ${stray.length > 1 ? 'they go' : 'it goes'} to the model as words` : '';
  const reading = (tone, line) => ({ marks, tone: stray.length && tone === 'info' ? 'warn' : tone, text: `${line}${words}` });
  if (check.terminalOnly) return reading('warn', `${check.terminalOnly} works in the terminal app only`);
  if (check.fixes?.length) return reading('warn', `Did you mean ${check.fixes.map(fix => `${fix.to} (not ${fix.from})`).join(', ')}? Enter offers the fix`);
  if (LOCAL_COMMANDS[head.name] && !byName.has(head.name)) return reading('info', LOCAL_COMMANDS[head.name]);
  if (!head.known) return reading('error', `/${head.name} is not a command here. Type / to browse what works`);
  // Whatever is left once the tokens are cut out is the task (or, for /goal, its subcommand and text).
  let rest = raw;
  for (const token of [...tokens].reverse()) rest = rest.slice(0, token.start) + ' ' + rest.slice(token.end);
  rest = rest.replace(/\s+/g, ' ').trim();
  const boosts = tokens.slice(head.name === 'goal' ? 1 : 0).filter(token => token.known && byName.get(token.name)?.chainable && token.name !== 'goal').map(token => token.name);
  const live = goal && (goal.status === 'active' || goal.status === 'paused');
  // A boost followed only by a goal word acts on the goal (goal.ts startPreset), when there is one.
  if (head.name === 'goal' || (byName.get(head.name)?.chainable && PRESET_GOAL_WORDS.has(rest.toLowerCase()) && goal)) {
    const [first = '', ...more] = rest.split(' ');
    const word = GOAL_WORDS[first.toLowerCase()];
    if (!rest) return reading('info', goal ? `Shows the goal: ${goal.status}, ${progress(goal)}` : 'Shows the goal and every /goal form; this session has none yet');
    if (word && !more.length) {
      if (word === 'help') return reading('info', 'Lists every /goal form');
      if (word === 'status') return reading('info', goal ? `Shows the goal: ${goal.status}, ${progress(goal)}` : 'This session has no goal yet');
      if (!goal) return reading('warn', `This session has no goal to ${first.toLowerCase()}; nothing will start. /goal <what you want> starts one`);
      return reading('info', { resume: `Resumes the ${goal.status === 'blocked' ? 'stalled ' : goal.status === 'paused' ? 'paused ' : ''}goal (${progress(goal)}) with a fresh continuation budget`,
        retry: `Retries the goal (${progress(goal)}) with a fresh continuation budget`, pause: 'Pauses the goal; /goal resume continues it',
        done: 'Marks the goal achieved yourself', clear: 'Drops the goal from this session' }[word]);
    }
    if ((word === 'resume' || word === 'retry') && goal) return reading('info', `Resumes the goal (${progress(goal)}); “${more.join(' ').slice(0, 60)}” goes along as your note`);
    if (first.toLowerCase() === 'criteria' && more.length) return reading(goal ? 'info' : 'warn', goal ? 'Replaces the goal’s open criteria' : 'This session has no goal to set criteria on');
    return reading(live ? 'warn' : 'info', `Starts a new goal${boosts.length ? ` with ${list(boosts)} applied` : ''}${live ? '; it replaces the current one' : ''}`);
  }
  const command = byName.get(head.name);
  if (command?.chainable) {
    if (rest) return reading('info', `${list(boosts)} → one goal for your task${boosts.length > 1 ? ', every boost applied together' : ''}`);
    if (live) return reading('info', `Adds ${list(boosts)} to the current goal (${progress(goal)})`);
    return reading('info', `${list(boosts)} → one goal on this project’s existing work`);
  }
  const about = String(command?.description ?? '').replace(/\s+/g, ' ').trim();
  return reading('info', `Runs /${head.name}${about ? `: ${about.length > 110 ? `${about.slice(0, 109)}…` : about}` : ''}`);
}
