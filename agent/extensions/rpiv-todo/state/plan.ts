/** The todo snapshot is the plan. No scheduler, second ledger or model call. */
import type { Task } from '../tool/types.js';
import { sanitizeTerminalText } from '../tool/sanitize.ts';

export const PLAN_FIELDS = ['parentId', 'execution', 'files', 'acceptance', 'evidence', 'refs', 'runId'] as const;
export const EXECUTIONS = ['self', 'subagent', 'swarm', 'fusion'] as const;
export function planFieldError(task: Partial<Task>): string | undefined {
  if (task.parentId != null && (!Number.isSafeInteger(task.parentId) || task.parentId < 1)) return 'parentId must be a positive task id or null';
  if (task.execution !== undefined && !EXECUTIONS.includes(task.execution)) return 'Unknown execution mode';
  // Ownership coherence: a task recovered in the parent cannot still claim
  // delegated execution. Recovery sets owner/execution/evidence/refs/runId
  // together (see lib/todo-linkage.ts); partial states are rejected here.
  if (task.owner === 'parent' && task.execution !== undefined && task.execution !== 'self') {
    return "owner 'parent' requires execution 'self': set execution, evidence, refs and runId together when recovering delegated work";
  }
  for (const key of ['files', 'refs'] as const) {
    const value = task[key];
    if (value !== undefined && (!Array.isArray(value) || value.length > 32 || value.some(x => typeof x !== 'string' || !x.trim() || x.length > 512))) return `${key} requires at most 32 nonempty strings of at most 512 characters`;
  }
  for (const key of ['acceptance', 'evidence', 'runId'] as const) if (task[key] !== undefined && (typeof task[key] !== 'string' || task[key]!.length > 2000)) return `${key} must be text of at most 2000 characters`;
}

/** Parent completion waits on children; dependencies and hierarchy share a DAG. */
export function planGraphError(tasks: readonly Task[]): string | undefined {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const edges = new Map(tasks.map(t => [t.id, [...(t.blockedBy ?? [])]]));
  for (const task of tasks) {
    const invalid = planFieldError(task); if (invalid) return invalid;
    if (task.parentId == null) continue;
    const parent = byId.get(task.parentId);
    if (!parent || parent.id === task.id) return 'parentId must name another existing task';
    if (task.status !== 'deleted' && parent.status === 'deleted') return 'Reparent or delete children before deleting their parent';
    if (task.status !== 'deleted' && task.status !== 'completed' && parent.status === 'completed') return 'Reopen the parent before adding or reopening unfinished children';
    if (task.status !== 'deleted') edges.get(parent.id)!.push(task.id);
  }
  // Starting a child inherits the parent's prerequisites. Include those edges
  // too, so a parent depending on its own descendant cannot deadlock the plan.
  for (const task of tasks) {
    const seen = new Set<number>([task.id]);
    for (let parent = byId.get(task.parentId!); parent && !seen.has(parent.id); parent = byId.get(parent.parentId!)) {
      seen.add(parent.id); edges.get(task.id)!.push(...(parent.blockedBy ?? []));
    }
  }
  // Iterative traversal handles old, very deep snapshots without stack overflow.
  const indegree = new Map(tasks.map(t => [t.id, 0]));
  for (const targets of edges.values()) for (const id of targets) if (indegree.has(id)) indegree.set(id, indegree.get(id)! + 1);
  const queue = [...indegree].filter(([,n]) => n === 0).map(([id]) => id);
  for (let at = 0; at < queue.length; at++) for (const id of edges.get(queue[at]) ?? []) {
    if (!indegree.has(id)) continue;
    indegree.set(id, indegree.get(id)! - 1); if (indegree.get(id) === 0) queue.push(id);
  }
  if (queue.length !== tasks.length) return 'Hierarchy and dependencies would create a cycle';
}

export function blockers(task: Task, tasks: readonly Task[], byId = new Map(tasks.map(t => [t.id, t]))): number[] {
  const blocked = new Set<number>(), seen = new Set<number>();
  for (let at: Task | undefined = task; at && !seen.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) {
    seen.add(at.id);
    for (const id of at.blockedBy ?? []) if (byId.get(id)?.status !== 'completed') blocked.add(id);
  }
  return [...blocked];
}

export function planRows(tasks: readonly Task[]) {
  const live = tasks.filter(t => t.status !== 'deleted'), byId = new Map(live.map(t => [t.id, t]));
  const groups = new Map<number | null, Task[]>();
  for (const task of live) { const key = byId.has(task.parentId!) ? task.parentId! : null; const rows = groups.get(key) ?? []; rows.push(task); groups.set(key, rows); }
  const result: Array<{task: Task; depth: number; ready: boolean; blocked: number[]}> = [], seen = new Set<number>();
  const pending = [...(groups.get(null) ?? [])].reverse().map(task => ({task, depth: 0}));
  while (pending.length) {
    const {task, depth} = pending.pop()!; if (seen.has(task.id)) continue; seen.add(task.id);
    const children = groups.get(task.id) ?? [], blocked = blockers(task, live, byId);
    result.push({task, depth, blocked, ready: task.status === 'pending' && !blocked.length && children.every(t => t.status === 'completed')});
    for (const child of [...children].reverse()) pending.push({task: child, depth: depth + 1});
  }
  return result;
}

export function renderPlan(tasks: readonly Task[], view: 'tree' | 'frontier' = 'tree', budget = 6000): string {
  const rows = planRows(tasks), selected = view === 'frontier' ? rows.filter(r => r.task.status === 'in_progress' || r.ready) : rows;
  let text = `Plan: ${rows.filter(r => r.task.status === 'completed').length}/${rows.length} completed.\n`, shown = 0;
  for (const row of selected) {
    const t = row.task;
    const line = `${'  '.repeat(Math.min(row.depth, 8))}#${t.id}${t.parentId ? ` <#${t.parentId}` : ''} [${t.status}${row.ready ? '; ready' : ''}] ${sanitizeTerminalText(t.subject).slice(0, 200)}${t.execution ? ` (${t.execution})` : ''}${t.runId ? ` run=${sanitizeTerminalText(t.runId).slice(0,80)}` : ''}${row.blocked.length ? ` waits:${row.blocked.join(',')}` : ''}\n`;
    if (text.length + line.length + 110 > budget) break;
    text += line; shown++;
  }
  if (shown < rows.length) text += `${rows.length-shown} other nodes; todo list view=tree or get id for full criteria, files and evidence.\n`;
  return text;
}

export const PLAN_GUIDANCE = 'For each actionable user request, create or revise the todo plan autonomously: outcomes → executable steps, parentId, dependencies and acceptance checks. Preserve open work across follow-ups; revise affected nodes, not the whole goal. Choose self/subagent/swarm/fusion per step and record files, owner/runId and project/evidence refs. Mark steps in_progress with activeForm before acting. Modes describe intent, never dispatch or grant permission. Use native orchestration tools, inspect results, record evidence, then complete. Use batch for related edits; list view=frontier for next work.';
