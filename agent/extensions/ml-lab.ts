import { Type } from 'typebox';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { choices } from './lib/tool-schema.ts';
import { readSourceFiles } from './pi-lens/context-code.mjs';
import { auditSplits, evaluateModel, rlTargets, notebookAudit, mlPreflight } from './lib/ml-lab.ts';

export default function registerMlLab(pi: any) {
  pi.registerTool({
    name: 'ml_lab', label: 'ML lab',
    description: 'Local ML engineering tools: preflight host/memory lower bounds; split_audit finds content/id/group/time leakage; evaluate computes classification/regression metrics, slice errors and paired baseline bootstrap intervals; rl_targets checks terminal versus truncated bootstraps; notebook checks Colab stage/outputs; recipe locates executable tiny MLP, offline tabular-Q, embedding or causal LoRA trainers and a Colab notebook. This tool makes no model calls, executes no arbitrary code and allocates no cloud runtime. Supply data inline or a workspace JSON/ipynb path. Training runs through existing bash/bg_run with explicit argv and durable checkpoint/metrics receipts.',
    promptGuidelines: ['Use split_audit before training, a finite smoke/save/reload/resume check, and evaluate on frozen cases with a baseline. A prepared notebook is not a trained model or connected Colab runtime.'],
    parameters: Type.Object({
      operation: choices(['preflight', 'split_audit', 'evaluate', 'rl_targets', 'notebook', 'recipe']),
      path: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 9999, description: 'Page through 64 targets/findings or 32 class metrics. Use a workspace input path to reuse data.' })),
      data: Type.Optional(Type.Any({ description: 'Bounded operation input. split_audit: samples [{id,split,features or text,group?,time?,label?}], grouped/temporal/task. evaluate: task,targets,predictions,baseline?,groups?. rl_targets: gamma,transitions [{reward,nextValue,terminated,truncated}]. notebook: v4 notebook. preflight: parameters?,weightBytes?.' })),
      recipe: Type.Optional(choices(['tiny_mlp', 'tabular_q', 'embedding', 'lora'])),
    }),
    async execute(_id: string, input: any, signal?: AbortSignal, _update?: any, ctx?: any) {
      try {
        signal?.throwIfAborted();
        const offset = input.offset ?? 0;
        if (!Number.isInteger(offset) || offset < 0 || offset > 9999) throw Error('offset must be an integer in 0..9999');
        let data = input.data ?? {};
        if (input.path) {
          if (input.data !== undefined) throw Error('Supply data or path, not both');
          const sources = await readSourceFiles(ctx?.cwd ?? process.cwd(), [input.path], signal, (file: string) => /\.(?:json|ipynb)$/i.test(file));
          if (sources.errors.length || !sources.files.length) throw Error('ML input must be a regular workspace JSON/ipynb file <=256 KiB');
          data = JSON.parse(sources.files[0].source);
        }
        let details: any;
        if (input.operation === 'split_audit') details = auditSplits(data, signal);
        else if (input.operation === 'evaluate') details = evaluateModel(data, signal);
        else if (input.operation === 'rl_targets') details = rlTargets(data);
        else if (input.operation === 'notebook') details = notebookAudit(data);
        else if (input.operation === 'preflight') details = mlPreflight(data);
        else if (input.operation === 'recipe') {
          if (!['tiny_mlp', 'tabular_q', 'embedding', 'lora'].includes(input.recipe)) throw Error('Choose tiny_mlp, tabular_q, embedding or lora');
          const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts');
          const trainer = path.join(scripts, ['embedding', 'lora'].includes(input.recipe) ? 'ml-transformer-train.py' : 'ml-lab.py');
          const source = await fs.readFile(trainer);
          const installedPython = path.resolve(scripts, '../local-models/ml-training/venv/bin/python');
          const python = await fs.access(installedPython).then(() => installedPython, () => 'python3');
          details = { operation: 'recipe', recipe: input.recipe, trainer, sha256: createHash('sha256').update(source).digest('hex'),
            interpreter: python, requirements: path.resolve(scripts, '../skills/google-colab-training/assets/ml-training-requirements.txt'),
            validationArgv: [python, '-I', trainer, '--spec', 'experiment.json', '--check'],
            argv: [python, '-I', trainer, '--spec', 'experiment.json', '--output', 'runs/smoke', '--steps', '2'],
            resumeArgv: [python, '-I', trainer, '--spec', 'experiment.json', '--output', 'runs/full', '--resume', 'runs/smoke/checkpoint.json'],
            notebook: path.resolve(scripts, '../skills/google-colab-training/assets/ml-lab-training.ipynb'),
            stages: ['data/split audit', 'runtime preflight', '2-step smoke + save/reload', 'bounded training/resume', 'frozen held-out baseline comparison', 'export and target-runtime evaluation'],
            contract: 'Run --help for the spec contract. Local tiny_mlp and tabular_q use Python standard library only. embedding/lora require an explicitly prepared environment and immutable model revision; model loading may download weights. No dependencies are installed automatically. Use bg_run for long work and retain run/checkpoint ids.',
            status: 'prepared', runtime: 'unverified' };
        } else throw Error('Unknown ml_lab operation');
        signal?.throwIfAborted();
        let shown: any = details;
        const page = (rows: any[], size = 64) => rows.slice(offset, offset + size);
        const paging = (count: number, size = 64) => ({ offset, rowCount: count, nextOffset: offset + size < count ? offset + size : null });
        if (details.targets) shown = { ...details, targets: page(details.targets), ...paging(details.targets.length) };
        else if (details.findings) shown = { ...details, findings: page(details.findings), ...paging(details.findings.length) };
        else if (details.operation === 'evaluate') {
          const measured = { ...details.measured }, comparison = { ...details.comparison };
          if (measured.perClass) measured.perClass = page(measured.perClass, 32);
          if (comparison.baseline?.perClass) comparison.baseline = { ...comparison.baseline, perClass: page(comparison.baseline.perClass, 32) };
          shown = { ...details, measured, comparison,
            slices: details.slices.map(({ perClass, ...summary }: any) => ({ ...summary, ...(perClass ? { classCount: perClass.length } : {}) })),
            sliceDetail: 'Slices show aggregate metrics. For per-class slice detail, evaluate that slice of aligned arrays.',
            ...paging(Math.max(details.measured.perClass?.length ?? 0, details.comparison.baseline?.perClass?.length ?? 0), 32) };
        }
        const text = JSON.stringify(shown);
        if (text.length > 24000) throw Error('ML result exceeds the compact output budget; inspect a smaller slice or notebook scope');
        return { ...(details.ok === false ? { isError: true } : {}), content: [{ type: 'text', text }], details };
      } catch (error) { return { isError: true, content: [{ type: 'text', text: signal?.aborted ? 'Cancelled' : String(error instanceof Error ? error.message : error).slice(0, 400) }] }; }
    },
  });
}
