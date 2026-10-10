/** Capability filtering and conservative quotes. Unknown billing units remain
 * unknown; they cannot pass a capped automatic generation request. */
import { fetchMediaModels, mediaCatalogJson } from '@yunuspi/coding-agent';

export function selectedMediaParams(params: any, kind: string, selections: any = {}) {
  const explicit = params.model;
  const selection = explicit ?? selections[kind];
  if (typeof selection !== 'string' || !selection.includes('/')) return { ...params };
  const match = /^(openrouter|openai-compatible|elevenlabs|local)\/(.+)$/.exec(selection);
  if (!match) return { ...params };
  const [, provider, model] = match;
  const providers: Record<string, string[]> = { image: ['openrouter', 'openai-compatible'], speech: ['elevenlabs', 'local'], music: ['elevenlabs', 'local'], sfx: ['elevenlabs', 'local'] };
  if (!providers[kind]?.includes(provider)) throw Error(`${provider} is not a supported ${kind} generation route`);
  if (kind === 'speech' && explicit === undefined) {
    const backend = provider === 'local' ? 'piper' : 'elevenlabs';
    if (params.backend && params.backend !== 'auto' && params.backend !== backend || params.voice && backend !== 'piper' || params.voiceId && backend !== 'elevenlabs') return { ...params };
  }
  if (provider === 'local') return { ...params, ...(kind === 'speech' ? { backend: 'piper', model: undefined } : { mediaProvider: 'local', model }) };
  return { ...params, model, mediaProvider: provider, ...(kind === 'image' && provider === 'openrouter' && params.transport === undefined ? { transport: 'images' } : {}), ...(kind === 'speech' ? { backend: 'elevenlabs' } : {}) };
}

const price = (value: unknown) => value !== null && value !== '' && (typeof value === 'number' || typeof value === 'string') && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
export function costLimit(value: unknown, fallback: number) {
  const n = value === undefined ? fallback : typeof value === 'number' ? price(value) : null;
  if (n === null || n <= 0 || n > 500) throw Error('maxCostUsd must be a finite number greater than 0 and at most 500');
  return n;
}

export function imageCapabilityIssues(model: any, params: any, references = 0) {
  const caps = model.supported_parameters ?? {}, issues: string[] = [];
  const refs = caps.input_references;
  if (references > 0 && (!refs || refs.max !== undefined && references > refs.max)) issues.push('reference images');
  if (refs?.min > references) issues.push(`at least ${refs.min} reference images`);
  const fields: Record<string, unknown> = { aspect_ratio: params.aspectRatio, resolution: params.resolution, quality: params.quality, background: params.transparent === true ? 'transparent' : undefined, output_format: params.format, seed: params.seed, output_compression: params.compression, input_fidelity: params.inputFidelity, size: params.size };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const cap = caps[key];
    if (!cap || cap.type === 'enum' && !cap.values?.includes(value) || cap.type === 'range' && (Number(value) < cap.min || Number(value) > cap.max)) issues.push(`${key}:${value}`);
  }
  if (caps.output_format?.values?.length && caps.output_format.values.every((v: string) => v === 'svg')) issues.push('raster output');
  return issues;
}

export function quoteImageEndpoint(endpoint: any, references = 0) {
  if (!Array.isArray(endpoint.pricing) || !endpoint.pricing.length) return null;
  const groups = new Map<string, number>();
  let output = false;
  for (const line of endpoint.pricing) {
    const rate = price(line.cost_usd);
    if (rate === null || line.unit !== 'image' || !['output_image', 'input_image', 'input_reference'].includes(line.billable)) return null;
    if (line.billable === 'output_image') output = true;
    groups.set(line.billable, Math.max(groups.get(line.billable) ?? 0, rate));
  }
  if (!output) return null;
  return [...groups].reduce((sum, [key, rate]) => sum + rate * (key === 'output_image' ? 1 : references), 0);
}

export async function planImageModel(params: any, signal?: AbortSignal) {
  const references = params.action === 'edit' || params.path || params.references ? (params.references?.length ?? 1) : 0;
  const maxCostUsd = costLimit(params.maxCostUsd, .25);
  const models = await fetchMediaModels('image', { signal });
  const exact = params.model && params.model !== 'auto' ? String(params.model).replace(/^openrouter\//, '') : undefined;
  const compatible = models.filter((row: any) => (!exact || row.capabilities.id === exact) && !imageCapabilityIssues(row.capabilities, params, references).length);
  compatible.sort((a: any, b: any) => Number(/flash|lite|mini|fast/i.test(b.id)) - Number(/flash|lite|mini|fast/i.test(a.id)) || a.id.localeCompare(b.id));
  const candidates: any[] = [];
  // Bounded catalog work: avoid sixty endpoint reads for one image.
  const rows = compatible.slice(0, exact ? 1 : 8);
  let unavailableCatalogs = 0;
  for (let i = 0; i < rows.length; i += 4) {
    const batch = rows.slice(i, i + 4);
    const results = await Promise.allSettled(batch.map(row => mediaCatalogJson(`/images/models/${row.capabilities.id}/endpoints`, { signal })));
    signal?.throwIfAborted();
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') { unavailableCatalogs++; continue; }
      const row = batch[index];
      for (const endpoint of result.value.endpoints ?? []) {
        if (imageCapabilityIssues(endpoint, params, references).length) continue;
        const quotedCostUsd = quoteImageEndpoint(endpoint, references);
        if (quotedCostUsd !== null && quotedCostUsd <= maxCostUsd && typeof endpoint.provider_tag === 'string' && endpoint.provider_tag) candidates.push({ model: row.capabilities.id, provider: endpoint.provider_tag, quotedCostUsd, capabilities: endpoint.supported_parameters });
      }
    }
  }
  candidates.sort((a, b) => a.quotedCostUsd - b.quotedCostUsd || a.model.localeCompare(b.model));
  if (!candidates.length) throw Error('No compatible image endpoint with a known fixed image price fits maxCostUsd. Inspect /models Images, omit unsupported options, or choose a compatible model and budget explicitly. Token/megapixel pricing cannot prove this cap.');
  return { ...candidates[0], maxCostUsd, unavailableCatalogs, alternatives: candidates.slice(1, 5).map(({ capabilities, ...row }) => row), quote: 'Conservative catalog estimate for one output plus reference images; maximum published variant rate. Provider billing is reported separately.', automaticRetries: 0 };
}
