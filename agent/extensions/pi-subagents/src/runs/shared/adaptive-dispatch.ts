import { adaptiveExecutionEnabled, classifyExecution, type ExecutionProfile } from '../../../../lib/adaptive-execution.ts';

interface ChildBrief { task?: string; count?: number }
interface Group { parallel: ChildBrief[] | ChildBrief; concurrency?: number; expand?: { maxItems?: number } }
interface DispatchRequest extends ChildBrief {
  tasks?: ChildBrief[];
  chain?: (ChildBrief | Group)[];
  concurrency?: number;
  workflowScript?: string;
  workflowScriptPath?: string;
  globalConcurrencyLimit?: number;
}
interface DispatchConfig { parallel?: { concurrency?: number }; globalConcurrencyLimit?: number; chain?: { dynamicFanout?: { maxItems?: number } } }

/** Requested parallel work remains requested: tune only the absent scheduler
 * default. All items run, explicit per-group limits win, and human configured
 * capacity is preserved. A cheap independent pair need not be serialized. */
export function adaptiveDispatchDefaults<T extends DispatchRequest>(request: T, config: DispatchConfig = {}, profile?: ExecutionProfile) {
  const enabled = adaptiveExecutionEnabled();
  const changes: { path: string; concurrency: number; source: 'adaptive' | 'configuration' }[] = [];
  const object = (value: unknown) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
  // Admission/validation retains malformed-request diagnostics. An optional
  // default must not turn a typed refusal into an unhandled dispatch throw.
  if (request.tasks !== undefined && (!Array.isArray(request.tasks) || request.tasks.some(child => !object(child)))
    || request.chain !== undefined && (!Array.isArray(request.chain) || request.chain.some(step => !object(step)
      || 'parallel' in step && (Array.isArray(step.parallel) ? step.parallel.some(child => !object(child)) : !object(step.parallel))))) return {params:request,changes};
  const defaultWidth = (children: readonly ChildBrief[]) => Math.max(1, Math.min(
    children.reduce((total, child) => total + (Number.isSafeInteger(child.count) && child.count! > 0 ? child.count! : 1), 0) || 3,
    children.some(child => ['complex', 'critical'].includes(classifyExecution({ task: child.task ?? '', scope: 'subtask' }).tier)) || (profile?.failures ?? 0) >= 2 ? 3 : 2,
  ));
  const configuredWidth = config.parallel?.concurrency;
  const width = (current: number | undefined, children: readonly ChildBrief[], path: string) => {
    if (current !== undefined) return current;
    if (configuredWidth !== undefined) { changes.push({path,concurrency:configuredWidth,source:'configuration'}); return configuredWidth; }
    // A configured global limit is an explicit capacity choice too. Retain
    // the established per-group default rather than add an adaptive ceiling.
    if (!enabled || config.globalConcurrencyLimit !== undefined) return undefined;
    const concurrency = defaultWidth(children); changes.push({path,concurrency,source:'adaptive'}); return concurrency;
  };
  let params = request;
  if (request.tasks?.length) {
    const concurrency = width(request.concurrency, request.tasks, 'tasks');
    if (concurrency !== request.concurrency) params = {...params,concurrency};
  }
  if (request.chain?.length) {
    const chain = request.chain.map((step, index) => {
      if (!('parallel' in step)) return step;
      const children = Array.isArray(step.parallel) ? step.parallel : [{...step.parallel,count:step.expand?.maxItems ?? config.chain?.dynamicFanout?.maxItems ?? 3}];
      const concurrency = width(step.concurrency ?? request.concurrency, children, `chain[${index}]`);
      return concurrency !== step.concurrency && concurrency !== undefined ? {...step,concurrency} : step;
    });
    if (chain.some((step,index) => step !== request.chain![index])) params = {...params,chain};
  }
  if (enabled && (request.workflowScript !== undefined || request.workflowScriptPath !== undefined) && request.globalConcurrencyLimit === undefined && config.globalConcurrencyLimit === undefined) {
    // Script fan-out has no known item count until execution. Keep useful
    // parallelism with a bounded global default, never evaluate its source.
    params = {...params,globalConcurrencyLimit:3}; changes.push({path:'workflow',concurrency:3,source:'adaptive'});
  }
  return {params,changes};
}
