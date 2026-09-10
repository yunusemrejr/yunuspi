/** Launch-scoped harness maintenance authority. Never derive authority from tool cwd. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export function canonicalMutationPath(input: string, cwd = process.cwd()): string {
 let candidate = path.resolve(cwd, input), tail: string[] = [];
 for (;;) {
  try { return path.join(fs.realpathSync(candidate), ...tail); }
  catch (error) {
   if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
   const parent = path.dirname(candidate); if (parent === candidate) throw error;
   tail.unshift(path.basename(candidate)); candidate = parent;
  }
 }
}
export function containsPath(parent: string, child: string): boolean {
 const relative = path.relative(parent, child);
 return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
export const HARNESS_ROOT = canonicalMutationPath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'));
const INITIAL_CWD = canonicalMutationPath(process.cwd());
export const SELF_MUTATION_ALLOWED = process.env.PI_HARNESS_MUTATION_DENIED !== '1' && !process.env.PI_SUBAGENT_CHILD && containsPath(INITIAL_CWD, HARNESS_ROOT);
// Children inherit denial even if they change cwd or import another copy of this module.
if (!SELF_MUTATION_ALLOWED) process.env.PI_HARNESS_MUTATION_DENIED = '1';
const maintenanceSkill = path.join(HARNESS_ROOT, 'agent/skills/harness-self-maintenance/SKILL.md');
export const SELF_MUTATION_GUIDANCE = `Harness maintenance: inspect ${fs.existsSync(maintenanceSkill) ? JSON.stringify(maintenanceSkill) : 'the harness-self-maintenance skill'} and current maintenance map before changes. Preserve credentials and runtime state; make focused reversible edits, run relevant checks, and export only reviewed non-sensitive files. Child agents have no independent maintenance authority.`;
export function selfMutationDenial(target: string, cwd: string): string | undefined {
 if (SELF_MUTATION_ALLOWED) return;
 try {
  const resolved = canonicalMutationPath(target.startsWith('~/') ? path.join(process.env.HOME || '', target.slice(2)) : target, cwd);
  const stat = fs.existsSync(resolved) ? fs.statSync(resolved) : undefined;
  if (stat?.isFile() && stat.nlink > 1) return 'Blocked: modifying a hard-linked file could alter a protected harness alias. Use an independent project copy.';
  if (containsPath(HARNESS_ROOT, resolved) || containsPath(resolved, HARNESS_ROOT)) return 'Blocked: this session was launched outside the harness maintenance directory. Harness writes require a new human-started session in the harness root or an ancestor; changing cwd or using a subagent does not grant authority.';
 } catch { return 'Blocked: unable to safely resolve mutation target.'; }
}
/** Every untrusted executable must use this wrapper, not merely commands mentioning .pi. */
export function guardedCommand(command: string, args: readonly string[]): { command: string; args: string[] } {
 if (SELF_MUTATION_ALLOWED) return { command, args: [...args] };
 if (process.platform !== 'linux') throw new Error('Harness write isolation requires Linux bubblewrap. Use the documented WSL2/Linux VM runtime. No unisolated command was started.');
 return { command: '/usr/bin/python3', args: ['-I', path.join(HARNESS_ROOT, 'agent/scripts/harness-readonly-exec.py'), HARNESS_ROOT, '--', command, ...args] };
}
