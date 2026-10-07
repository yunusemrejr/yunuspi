import { createHash } from 'node:crypto';
import { normalizeVerdict } from './creative-qa.ts';

type Capture = { runId: string; source: string; surface?: string; revision: string; consistent?: boolean; file: string; sections: any[]; dom?: any; errors?: any[]; responsiveHash?: string };
type Run = { capture: Capture; stamp: string; imageHash: string; seen: boolean };
type Obligation = { id: string; revision: string; state: string; line: string };

/** Evidence owned by art-direction, independent of skills and the executing
 * provider. Measurements, delivered pixels and judgments are distinct facts. */
export function createCreativeEvidence() {
  const changes = new Map<string, { hash: string; kind: 'ui' | 'svg' }>();
  const runs = new Map<string, Run>();
  const matrices = new Map<string, { stamp: string; kind: 'ui' | 'svg'; widths: number[]; status: string; imageHash: string; seen: boolean; findings: string[]; file?: string }>();
  const judgments = new Map<string, { stamp: string; kind: 'ui' | 'svg'; blocking: number; source: string; controls: number }>();
  const geometry = new Map<string, { stamp: string; failures: number }>();
  const interactions = new Map<string, { stamp: string; actions: Set<string> }>();
  let workspace = '', direction = 'null', overflow = false;
  const stamp = () => createHash('sha256').update(JSON.stringify([workspace, direction, [...changes].sort()])).digest('hex').slice(0, 20);
  const current = (entry: { stamp: string } | undefined) => entry?.stamp === stamp();
  const surfaces = (kind: 'ui' | 'svg') => {
    const entries = [...changes].filter(([, row]) => row.kind === kind).map(([file]) => file);
    const sources = entries.filter(file => kind === 'svg' || /\.html?(?:[?#].*)?$/i.test(file));
    return sources.length ? sources : entries.length ? ['application'] : [];
  };
  const uiSource = (source: string, dom?: any) => dom?.documentType ? /^(text\/html|application\/xhtml\+xml)$/.test(dom.documentType) : !/\.svg(?:[?#].*)?$/i.test(source);
  const matching = <T>(map: Map<string, T>, source: string): T | undefined => source === 'application'
    ? [...map.values()].findLast(row => current(row as any) && (row as any).kind === 'ui') : (map.get(source) as any)?.kind === 'ui' ? map.get(source) : undefined;
  const obligations = (): Obligation[] => {
    const rows: Obligation[] = [];
    const add = (id: string, state: string, line: string) => rows.push({ id, revision: stamp(), state, line });
    if (overflow) add('coverage', 'incomplete', 'UI change coverage exceeded 64 files; inspect the remaining scope and disclose incomplete verification.');
    for (const source of surfaces('ui')) {
      const matrix = matching(matrices, source);
      if (!current(matrix) || !matrix!.widths.some(w => w <= 320) || !matrix!.widths.some(w => w >= 1024))
        add(`responsive:${source}`, 'needs-capture', `${source}: run ui_explore at narrow (320px), mobile, tablet and desktop on the final revision.`);
      else if (['fail', 'incomplete'].includes(matrix!.status)) add(`responsive:${source}`, matrix!.status, `${source}: responsive measurements ${matrix!.status}; repair defects or disclose the precise unresolved coverage.`);
      else if (!matrix!.seen) add(`responsive:${source}`, 'needs-pixels', `${source}: inspect the responsive matrix pixels with read/vision or permitted image_understand; DOM measurements cannot judge mobile composition.`);
      const judgment = matching(judgments, source);
      if (!current(judgment) || judgment!.blocking) add(`visual:${source}`, 'unresolved', `${source}: visual review is missing, stale or unresolved; run visual_review, inspect pixels and record all rubric sections with runId.`);
      // Only the actual reviewed surface owns an interaction obligation; an
      // abandoned comparison capture cannot hold every future task open.
      const run = [...runs.values()].findLast(row => current(row) && uiSource(row.capture.source, row.capture.dom) && (source === 'application' || (row.capture.surface ?? row.capture.source) === source));
      const target = current(judgment) ? judgment : run ? { source: run.capture.source, controls: run.capture.dom?.controls } : undefined;
      if (target?.controls > 0) {
        const interaction = interactions.get(target.source);
        if (!current(interaction) || !interaction!.actions.has('keyboard') || !interaction!.actions.has('verify'))
          add(`interaction:${source}`, 'unresolved', `${target.source}: exercise the user task with browser_session, including keyboard/focus and verify the resulting state; screenshots alone are not interaction proof.`);
      }
    }
    for (const source of surfaces('svg')) {
      const inspected = geometry.get(source);
      if (!current(inspected) || inspected!.failures) add(`geometry:${source}`, 'unresolved', `${source}: SVG geometry is missing, stale or has blocking defects; run svg_inspect action review and repair references, bounds and scaling.`);
      const judgment = judgments.get(source);
      if (!current(judgment) || judgment!.blocking) add(`visual:${source}`, 'unresolved', `${source}: inspect intended-size SVG pixels and record visual_review; geometry scores cannot establish optical quality.`);
    }
    return rows.slice(0, 10);
  };
  return {
    stamp,
    changed: () => [...changes].map(([file, row]) => ({ file, ...row })),
    incompleteChangeCoverage() { overflow = true; },
    observe(file: string, hash: string, kind: 'ui' | 'svg') {
      if (hash === 'missing') { changes.delete(file); return; }
      if (changes.size >= 64 && !changes.has(file)) { overflow = true; return; }
      changes.set(file, { hash, kind });
    },
    workspace(token: string) { workspace = token; },
    direction(token: string) { direction = token; },
    run(capture: Capture, imageHash: string, seen: boolean, capturedStamp = stamp()) {
      if (!capture.consistent || capturedStamp !== stamp() || !imageHash) throw Error('Capture revision changed or is unavailable; run visual_review again on the final source.');
      runs.set(capture.runId, { capture, stamp: capturedStamp, imageHash, seen });
      while (runs.size > 24) runs.delete(runs.keys().next().value!);
    },
    vision(imageHash: string) {
      for (const run of [...runs.values(), ...matrices.values()]) if (current(run) && run.imageHash === imageHash) run.seen = true;
    },
    matrix(source: string, report: any, capturedStamp = stamp(), imageHash = '', seen = false) {
      if (!report.consistent || capturedStamp !== stamp()) return;
      const widths = (report.cells ?? []).filter((c: any) => c.ok && c.dom?.available).map((c: any) => c.width);
      matrices.delete(source);
      matrices.set(source, { stamp: capturedStamp, kind: uiSource(report.source ?? source, report.cells?.find((c: any) => c.ok)?.dom) ? 'ui' : 'svg', widths, status: report.status, imageHash, seen, findings: (report.findings ?? []).slice(0, 6), file: report.preview });
      while (matrices.size > 24) matrices.delete(matrices.keys().next().value!);
    },
    geometry(source: string, failures: number) { geometry.set(source, { stamp: stamp(), failures }); while (geometry.size > 64) geometry.delete(geometry.keys().next().value!); },
    responsive(source: string) {
      const matrix = matching(matrices, source);
      return current(matrix) ? { widths: matrix!.widths, status: matrix!.status, findings: matrix!.findings, imageHash: matrix!.imageHash, file: matrix!.file } : undefined;
    },
    interaction(source: string, action: string) {
      const previous = interactions.get(source);
      const row = current(previous) ? previous! : { stamp: stamp(), actions: new Set<string>() };
      row.actions.add(action); interactions.set(source, row);
      while (interactions.size > 24) interactions.delete(interactions.keys().next().value!);
    },
    record(input: { runId?: string; source: string; revision: string; verdict: unknown; dismissals?: Array<{ id: string; reason: string }> }) {
      const run = runs.get(input.runId ?? '');
      if (!run || run.capture.source !== input.source) throw Error('Record needs runId from a matching visual_review run in this session.');
      if (!current(run) || input.revision !== run.capture.revision) throw Error('Source or dependencies changed after capture; re-run visual_review before recording.');
      const verdict = normalizeVerdict(input.verdict);
      for (const section of run.capture.sections) {
        const judged = verdict.sections.find(s => s.id === section.id);
        if (!judged) throw Error(`Record every captured rubric section, including ${section.id}; omitted evidence cannot approve quality.`);
        if (section.needsVision && judged.verdict !== 'UNKNOWN' && !run.seen) throw Error('Visual judgment needs delivered pixels or image_understand evidence for this capture; the current route has not received them.');
        if (section.verdict === 'FAIL' && judged.verdict !== 'FAIL' && judged.verdict !== 'UNKNOWN' && !input.dismissals?.some(d => d.id === section.id && d.reason.trim().length >= 20))
          throw Error(`Measured ${section.id} failure needs repair or an explicit evidence-based dismissal.`);
      }
      const responsive = verdict.sections.find(section => section.id === 'responsive');
      if (responsive && !['UNKNOWN', 'FAIL'].includes(responsive.verdict)) {
        const matrix = matching(matrices, run.capture.surface ?? (surfaces('ui').includes(input.source) ? input.source : 'application'));
        if (!current(matrix) || !matrix!.seen || !run.capture.responsiveHash || matrix!.imageHash !== run.capture.responsiveHash)
          throw Error('Responsive judgment needs the current inspected ui_explore contact sheet captured by this review; run the matrix, inspect it and re-run visual_review.');
      }
      if (run.capture.errors?.length && !input.dismissals?.some(d => d.id === 'load-errors' && d.reason.trim().length >= 20) && verdict.blocking === 0)
        throw Error('Capture has load/runtime errors; repair them or record a specific load-errors dismissal.');
      const surface = run.capture.surface ?? input.source;
      judgments.delete(surface);
      judgments.set(surface, { stamp: stamp(), kind: uiSource(input.source, run.capture.dom) ? 'ui' : 'svg', blocking: verdict.blocking, source: input.source, controls: run.capture.dom?.controls ?? 0 });
      while (judgments.size > 24) judgments.delete(judgments.keys().next().value!);
      return verdict;
    },
    gaps: () => obligations().map(row => row.line),
    verification: obligations,
  };
}
