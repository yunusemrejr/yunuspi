import { adaptiveExecutionEnabled, classifyExecution, type ExecutionProfile } from '../../../../lib/adaptive-execution.ts';
import { findModelInfo, getSupportedThinkingLevels, THINKING_LEVELS, splitKnownThinkingSuffix, type ModelInfo, type ThinkingLevel } from '../../shared/model-info.ts';
import { decodeThinkingCeiling, intersectThinkingCeilings, SUBAGENT_THINKING_CEILING_ENV } from '../../shared/thinking-ceiling.ts';

interface ChildBrief { task?: string; model?: string; thinking?: string | false; count?: number }
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

/** Match native flat launch indices, including count expansion and reserved
 * dynamic slots, without copying child briefs or allocating a fan-out array. */
export function adaptiveChildBrief(request: DispatchRequest, index: number, dynamicMaxItems?: number): ChildBrief | undefined {
  if (!Number.isSafeInteger(index) || index < 0) return;
  let offset = 0;
  const find = (child: ChildBrief, copies = 1) => {
    const amount = Number.isSafeInteger(copies) && copies > 0 ? copies : 0;
    const selected = index >= offset && index < offset + amount;
    offset += amount; return selected ? child : undefined;
  };
  if (request.tasks) {
    for (const child of request.tasks) { const selected = find(child, child.count ?? 1); if (selected) return selected; }
    return;
  }
  if (request.chain) {
    for (const step of request.chain) {
      if ('parallel' in step) {
        if (Array.isArray(step.parallel)) {
          for (const child of step.parallel) { const selected = find(child, child.count ?? 1); if (selected) return selected; }
        } else {
          const selected = find(step.parallel, step.expand?.maxItems ?? dynamicMaxItems ?? 0); if (selected) return selected;
        }
      } else { const selected = find(step); if (selected) return selected; }
    }
    return;
  }
  return index === 0 ? request : undefined;
}

/** Per-child native default. Agent/settings and model suffix pins stay exact;
 * the automatic choice respects inherited ceilings and actual model support.
 * Classification uses the authored brief, before task-state/fork additions. */
export function adaptiveNativeChildThinking(input: {
  brief?: ChildBrief; model?: string; agentThinking?: string | false;
  requestThinking?: string | false; maxThinking?: ThinkingLevel;
  availableModels?: ModelInfo[]; provider?: string;
  fallbackModels?: readonly string[];
  externalRunner?: boolean;
}): ThinkingLevel | undefined {
  if (!adaptiveExecutionEnabled() || input.externalRunner || !input.brief || input.agentThinking !== undefined
    || input.requestThinking !== undefined || input.brief.thinking !== undefined
    || splitKnownThinkingSuffix(input.model ?? '').thinkingSuffix
    || input.fallbackModels?.some(model => splitKnownThinkingSuffix(model).thinkingSuffix)) return;
  const model = findModelInfo(input.model, input.availableModels, input.provider);
  if (!model?.reasoning) return;
  const ceiling = intersectThinkingCeilings(input.maxThinking, decodeThinkingCeiling(process.env[SUBAGENT_THINKING_CEILING_ENV]));
  const task = input.brief.task ?? '';
  const uncertain = !task.trim() || /^(?:\{(?:task|previous|item|key)\}\s*)+$/.test(task.trim());
  const target = classifyExecution({task,scope:'subtask',uncertainty:uncertain ? .6 : 0}).reasoning;
  const supported = getSupportedThinkingLevels(model).filter(level => !ceiling || THINKING_LEVELS.indexOf(level) <= THINKING_LEVELS.indexOf(ceiling));
  if (supported.includes(target)) return target;
  const targetRank = THINKING_LEVELS.indexOf(target);
  return supported.find(level => THINKING_LEVELS.indexOf(level) > targetRank) ?? [...supported].reverse()[0];
}
