/** Bounded local glTF 2.0 preflight. Structural/resource checks, never GPU or artistic approval.
 * Layout reference: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html
 * Reuses the asset registry; no remote fetches, decoders or new rendering owner. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { containsPath } from './path-safety.ts';
import { sniffDimensions } from './asset-registry.ts';

export const GLTF_LIMITS = { jsonBytes: 2 * 1024 * 1024, fileBytes: 40 * 1024 * 1024, totalBytes: 96 * 1024 * 1024, resources: 128, items: 4096, vertices: 2_000_000 } as const;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const obj = (value: any, label: string): any => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`${label} must be an object`); return value; };
const integer = (value: any, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number => { if (!Number.isSafeInteger(value) || value < min || value > max) throw Error(`${label} must be an integer in ${min}..${max}`); return value; };
const array = (value: any, label: string, limit = GLTF_LIMITS.items): any[] => { if (value === undefined) return []; if (!Array.isArray(value) || value.length > limit) throw Error(`${label} must be an array of at most ${limit} entries`); return value; };
const index = (value: any, entries: any[], label: string) => integer(value, label, 0, entries.length - 1);
const vector = (value: any, size: number, label: string) => { if (!Array.isArray(value) || value.length !== size || value.some(x => typeof x !== 'number' || !Number.isFinite(x))) throw Error(`${label} must contain ${size} finite numbers`); };

/** Read through an open descriptor with a bound, including files that grow after stat. */
async function readBounded(file: string, limit: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw Error(`glTF resource must be a regular file at most ${Math.round(limit / 1024 / 1024)} MiB`);
    const bytes = Buffer.alloc(Math.min(limit + 1, stat.size + 1));
    let used = 0;
    while (used < bytes.length) { signal?.throwIfAborted(); const got = await handle.read(bytes, used, bytes.length - used, used); if (!got.bytesRead) break; used += got.bytesRead; }
    if (used !== stat.size) throw Error('glTF resource changed size during inspection');
    return bytes.subarray(0, used);
  } finally { await handle.close(); }
}

export function parseGltf(bytes: Buffer, binary: boolean): { document: any; bin?: Buffer } {
  let json = bytes, bin: Buffer | undefined;
  if (binary) {
    if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw Error('Invalid GLB v2 header or declared length');
    let offset = 12, chunks = 0;
    while (offset < bytes.length) {
      if (offset + 8 > bytes.length) throw Error('Truncated GLB chunk header');
      const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4);
      if (length % 4 || offset + 8 + length > bytes.length) throw Error('Invalid GLB chunk alignment or length');
      const chunk = bytes.subarray(offset + 8, offset + 8 + length);
      if (chunks === 0) { if (type !== 0x4e4f534a) throw Error('GLB first chunk must be JSON'); json = chunk; }
      else if (type === 0x004e4942) { if (chunks !== 1 || bin) throw Error('GLB BIN chunk must follow JSON once'); bin = chunk; }
      offset += 8 + length; chunks++;
    }
  }
  if (json.length > GLTF_LIMITS.jsonBytes) throw Error('glTF JSON exceeds 2 MiB');
  let document: any;
  try { document = obj(JSON.parse(json.toString('utf8')), 'glTF'); } catch (error: any) { throw Error(`Invalid glTF JSON: ${String(error.message).slice(0, 160)}`); }
  if (document.asset?.version !== '2.0' || (document.asset.minVersion && document.asset.minVersion !== '2.0')) throw Error('Only glTF 2.0 is supported');
  return { document, bin };
}

export async function inspectGltf(file: string, signal?: AbortSignal) {
  const resolved = await fs.realpath(file), directory = path.dirname(resolved);
  if (!/\.(gltf|glb)$/i.test(resolved)) throw Error('Model inspection supports local .gltf or .glb');
  const source = await readBounded(resolved, /\.glb$/i.test(resolved) ? GLTF_LIMITS.fileBytes : GLTF_LIMITS.jsonBytes, signal);
  const { document: g, bin } = parseGltf(source, /\.glb$/i.test(resolved));
  const buffers = array(g.buffers, 'buffers', 128), views = array(g.bufferViews, 'bufferViews'), accessors = array(g.accessors, 'accessors');
  const meshes = array(g.meshes, 'meshes'), nodes = array(g.nodes, 'nodes'), scenes = array(g.scenes, 'scenes');
  const images = array(g.images, 'images', 128), textures = array(g.textures, 'textures', 128), materials = array(g.materials, 'materials');
  const animations = array(g.animations, 'animations', 128);
  const warnings: string[] = [], warning = (s: string) => { if (warnings.length < 12 && !warnings.includes(s)) warnings.push(s); };
  const resourceBytes = new Map<string, Buffer>();
  const resources = new Map<string, { file: string; bytes: number; sha256: string }>();
  let totalBytes = source.length, embeddedBytes = 0;
  async function resource(uri: any): Promise<Buffer> {
    if (typeof uri !== 'string' || !uri || uri.length > GLTF_LIMITS.fileBytes * 1.4) throw Error('glTF URI missing or oversized');
    if (uri.startsWith('data:')) {
      const match = /^data:(?:application\/(?:octet-stream|gltf-buffer)|image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(uri);
      if (!match || match[1].length % 4) throw Error('Only bounded base64 buffer/PNG/JPEG/WebP data URIs are supported');
      const bytes = Buffer.from(match[1], 'base64');
      if (bytes.length > GLTF_LIMITS.fileBytes) throw Error('Embedded glTF resource exceeds 40 MiB');
      embeddedBytes += bytes.length; if (embeddedBytes > GLTF_LIMITS.totalBytes) throw Error('Embedded glTF resources exceed 96 MiB');
      return bytes;
    }
    if (uri.length > 4096) throw Error("Local glTF resource URI exceeds 4096 characters");
    let relative: string;
    try { relative = decodeURIComponent(uri); } catch { throw Error('Invalid glTF URI encoding'); }
    if (/^[a-z][a-z0-9+.-]*:/i.test(relative) || /[\\\x00-\x1f?#]/.test(relative) || path.isAbsolute(relative) || relative.split('/').includes('..')) throw Error('glTF resources must use contained relative local paths; no network, query, traversal or backslash');
    const candidate = await fs.realpath(path.resolve(directory, relative)).catch(() => { throw Error(`Missing glTF resource: ${relative.slice(0, 120)}`); });
    if (!containsPath(directory, candidate)) throw Error('glTF resource symlink escapes the model directory');
    if (!resources.has(candidate)) {
      if (resources.size >= GLTF_LIMITS.resources) throw Error('glTF exceeds 128 local resources');
      const bytes = await readBounded(candidate, Math.min(GLTF_LIMITS.fileBytes, GLTF_LIMITS.totalBytes - totalBytes), signal);
      totalBytes += bytes.length;
      resources.set(candidate, { file: relative, bytes: bytes.length, sha256: hash(bytes) });
      resourceBytes.set(candidate, bytes);
      return bytes;
    }
    return resourceBytes.get(candidate)!;
  }
  const bufferData: Buffer[] = [];
  for (const [i, raw] of buffers.entries()) {
    const b = obj(raw, `buffer ${i}`), length = integer(b.byteLength, `buffer ${i} byteLength`, 1, GLTF_LIMITS.totalBytes);
    const data = b.uri === undefined && i === 0 && bin ? bin : await resource(b.uri);
    if (data.length < length || (b.uri === undefined && data.length > length + 3)) throw Error(`buffer ${i} byteLength does not match resource`);
    bufferData.push(data.subarray(0, length));
  }
  for (const [i, raw] of views.entries()) {
    const v = obj(raw, `bufferView ${i}`), b = index(v.buffer, buffers, `bufferView ${i} buffer`);
    const offset = integer(v.byteOffset ?? 0, `bufferView ${i} byteOffset`), length = integer(v.byteLength, `bufferView ${i} byteLength`, 1);
    if (offset + length > bufferData[b].length) throw Error(`bufferView ${i} exceeds its buffer`);
    if (v.byteStride !== undefined && integer(v.byteStride, `bufferView ${i} byteStride`, 4, 252) % 4) throw Error('bufferView byteStride must be a multiple of 4');
    const packed = v.extensions?.EXT_meshopt_compression;
    if (packed) { const b = index(packed.buffer, buffers, 'meshopt buffer'); const at = integer(packed.byteOffset ?? 0, 'meshopt byteOffset'), len = integer(packed.byteLength, 'meshopt byteLength', 1); if (at + len > bufferData[b].length) throw Error('meshopt payload exceeds its buffer'); warning('Meshopt payload is bounded but not decoded.'); }
  }
  const sizes: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
  const componentBytes: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  let inspectedValues = 0;
  const compressedAccessors = new Set<number>();
  for (const mesh of meshes) for (const p of array(mesh?.primitives, 'primitives', 2048)) if (p?.extensions?.KHR_draco_mesh_compression) {
    for (const a of Object.values(p.attributes ?? {})) compressedAccessors.add(index(a, accessors, 'compressed attribute'));
    if (p.indices !== undefined) compressedAccessors.add(index(p.indices, accessors, 'compressed indices'));
    index(p.extensions.KHR_draco_mesh_compression.bufferView, views, 'Draco bufferView');
  }
  for (const [i, raw] of accessors.entries()) {
    const a = obj(raw, `accessor ${i}`), count = integer(a.count, `accessor ${i} count`, 1, GLTF_LIMITS.vertices);
    if (!sizes[a.type] || !componentBytes[a.componentType]) throw Error(`accessor ${i} has unsupported type/componentType`);
    const component = componentBytes[a.componentType];
    // Matrix columns are 4-byte aligned (MAT2/MAT3 byte/short components include padding).
    const column = a.type.startsWith('MAT') ? Number(a.type.at(-1)) : 0;
    const itemBytes = column ? column * Math.ceil(column * component / 4) * 4 : sizes[a.type] * component;
    const offset = integer(a.byteOffset ?? 0, `accessor ${i} byteOffset`);
    if (a.bufferView !== undefined) {
      const v = views[index(a.bufferView, views, `accessor ${i} bufferView`)];
      const stride = v.byteStride ?? itemBytes;
      if (stride < itemBytes || stride % component || offset % component || ((v.byteOffset ?? 0) + offset) % component || offset + (count - 1) * stride + itemBytes > v.byteLength) throw Error(`accessor ${i} exceeds its bufferView or has invalid alignment/stride`);
    } else if (!a.sparse && !compressedAccessors.has(i)) throw Error(`accessor ${i} needs a bufferView or sparse data`);
    if (a.sparse) {
      const s = obj(a.sparse, `accessor ${i} sparse`), n = integer(s.count, `accessor ${i} sparse count`, 1, count);
      const ids = obj(s.indices, 'sparse indices'), vals = obj(s.values, 'sparse values');
      if (![5121, 5123, 5125].includes(ids.componentType)) throw Error('Invalid sparse indices componentType');
      for (const [part, bytes] of [[ids, componentBytes[ids.componentType]], [vals, itemBytes]] as const) {
        const view = views[index(part.bufferView, views, 'sparse bufferView')];
        const at = integer(part.byteOffset ?? 0, 'sparse byteOffset');
        if (view.byteStride !== undefined || at + n * bytes > view.byteLength) throw Error('Sparse data exceeds its bufferView or uses byteStride');
      }
      warning('Sparse accessor values are bounded but not decoded; bounds and animation timing may be unavailable.');
    }
  }
  function values(i: number): number[] | undefined {
    const a = accessors[i];
    if (a.sparse || a.bufferView === undefined || a.type.startsWith('MAT') || views[a.bufferView]?.extensions?.EXT_meshopt_compression) return undefined;
    const count = a.count * sizes[a.type]; inspectedValues += count;
    if (inspectedValues > GLTF_LIMITS.vertices * 4) throw Error('glTF decoded-value work exceeds 8 million components');
    const v = views[a.bufferView], data = bufferData[v.buffer], stride = v.byteStride ?? componentBytes[a.componentType] * sizes[a.type], out: number[] = [];
    const readers: Record<number, (offset: number) => number> = { 5120: o => data.readInt8(o), 5121: o => data.readUInt8(o), 5122: o => data.readInt16LE(o), 5123: o => data.readUInt16LE(o), 5125: o => data.readUInt32LE(o), 5126: o => data.readFloatLE(o) };
    for (let n = 0; n < a.count; n++) {
      if (n % 4096 === 0) signal?.throwIfAborted();
      for (let c = 0; c < sizes[a.type]; c++) { const x = readers[a.componentType]((v.byteOffset ?? 0) + (a.byteOffset ?? 0) + n * stride + c * componentBytes[a.componentType]); if (!Number.isFinite(x)) throw Error(`accessor ${i} contains a nonfinite value`); out.push(x); }
    }
    return out;
  }
  let primitives = 0, vertices = 0, triangles = 0, boundsComplete = true;
  const meshBounds: Array<{ mesh: number; min: number[]; max: number[] }> = [];
  for (const [i, raw] of meshes.entries()) {
    const mesh = obj(raw, `mesh ${i}`), min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let bounded = false;
    for (const rawPrimitive of array(mesh.primitives, 'primitives', 2048)) {
      if (++primitives > 2048) throw Error('glTF exceeds 2048 primitives');
      const p = obj(rawPrimitive, 'primitive'), attrs = obj(p.attributes, 'primitive attributes');
      for (const a of Object.values(attrs)) index(a, accessors, 'attribute accessor');
      const pos = accessors[index(attrs.POSITION, accessors, 'POSITION accessor')];
      vertices += pos.count; if (vertices > GLTF_LIMITS.vertices) throw Error('glTF exceeds 2 million declared vertices');
      if (p.material !== undefined) index(p.material, materials, 'primitive material');
      let count = pos.count;
      if (p.indices !== undefined) {
        const a = accessors[index(p.indices, accessors, 'index accessor')];
        if (a.type !== 'SCALAR' || ![5121, 5123, 5125].includes(a.componentType)) throw Error('Primitive indices must be unsigned integer SCALAR');
        count = a.count;
        const decoded = values(p.indices); if (decoded?.some(n => n >= pos.count)) throw Error('Primitive index exceeds POSITION count');
      }
      const mode = integer(p.mode ?? 4, 'primitive mode', 0, 6);
      if (mode === 4) { if (count % 3) throw Error('TRIANGLES count must be divisible by 3'); triangles += count / 3; }
      else if (mode === 5 || mode === 6) triangles += Math.max(0, count - 2);
      if (p.extensions?.KHR_draco_mesh_compression || pos.type !== 'VEC3' || pos.componentType !== 5126 || pos.sparse) { boundsComplete = false; continue; }
      const decoded = values(attrs.POSITION);
      if (!decoded) { boundsComplete = false; continue; }
      for (let n = 0; n < decoded.length; n++) { const c = n % 3; min[c] = Math.min(min[c], decoded[n]); max[c] = Math.max(max[c], decoded[n]); }
      bounded = true;
    }
    if (bounded && meshBounds.length < 16) meshBounds.push({ mesh: i, min, max });
  }
  const parentCounts = new Uint16Array(nodes.length), state = new Uint8Array(nodes.length);
  for (const [i, raw] of nodes.entries()) {
    const node = obj(raw, `node ${i}`);
    if (node.mesh !== undefined) index(node.mesh, meshes, 'node mesh');
    for (const child of array(node.children, 'node children')) { index(child, nodes, 'child node'); if (++parentCounts[child] > 1) throw Error('glTF nodes cannot have multiple parents'); }
    for (const [key, size] of [['matrix', 16], ['translation', 3], ['rotation', 4], ['scale', 3]] as const) if (node[key] !== undefined) vector(node[key], size, `node ${key}`);
    if (node.matrix && ['translation', 'rotation', 'scale'].some(k => node[k] !== undefined)) throw Error('Node cannot combine matrix with TRS');
  }
  for (let root = 0; root < nodes.length; root++) {
    if (state[root] === 2) continue;
    const stack: Array<[number, boolean]> = [[root, false]];
    while (stack.length) { const [i, leave] = stack.pop()!; if (leave) { state[i] = 2; continue; } if (state[i] === 1) throw Error('glTF node cycle'); if (state[i] === 2) continue; state[i] = 1; stack.push([i, true]); for (const child of nodes[i].children ?? []) stack.push([child, false]); }
  }
  for (const scene of scenes) for (const node of array(obj(scene, 'scene').nodes, 'scene nodes')) { index(node, nodes, 'scene root'); if (parentCounts[node]) throw Error('Scene root has a parent'); }
  if (g.scene !== undefined) index(g.scene, scenes, 'default scene');
  const imageDimensions = [];
  for (const [i, raw] of images.entries()) {
    const image = obj(raw, 'image');
    let bytes: Buffer;
    if (image.uri !== undefined) { if (image.bufferView !== undefined) throw Error('Image cannot combine URI with bufferView'); bytes = await resource(image.uri); }
    else { const v = views[index(image.bufferView, views, 'image bufferView')]; bytes = bufferData[v.buffer].subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength); }
    const dims = sniffDimensions(bytes);
    if (!dims.width || !dims.height) warning('Some image dimensions are unknown; decode/texture memory remains unverified.');
    if (dims.width && dims.height && dims.width * dims.height > 16_777_216) throw Error('glTF image exceeds 16 million pixels');
    if (dims.width && dims.height && Math.max(dims.width, dims.height) > 2048) warning('Textures exceed 2048px; downsize before software GL or mobile rendering.');
    if (imageDimensions.length < 16) imageDimensions.push({ image: i, width: dims.width, height: dims.height });
  }
  for (const texture of textures) if (obj(texture, 'texture').source !== undefined) index(texture.source, images, 'texture source');
  const animationClips = [];
  for (const [i, raw] of animations.entries()) {
    const a = obj(raw, 'animation'), samplers = array(a.samplers, 'animation samplers');
    let duration: number | null = 0;
    for (const s of samplers) {
      obj(s, 'animation sampler'); const input = accessors[index(s.input, accessors, 'animation input')]; index(s.output, accessors, 'animation output');
      if (input.type !== 'SCALAR' || input.componentType !== 5126) throw Error('Animation time input must be float SCALAR');
      const times = values(s.input);
      if (!times) { duration = null; continue; }
      if (times.some((t, n) => t < 0 || (n > 0 && t <= times[n - 1]))) throw Error('Animation times must be nonnegative and strictly increasing');
      if (duration !== null) duration = Math.max(duration, times.at(-1) ?? 0);
    }
    for (const channel of array(a.channels, 'animation channels')) { index(obj(channel, 'animation channel').sampler, samplers, 'channel sampler'); index(channel.target?.node, nodes, 'channel target'); if (!['translation', 'rotation', 'scale', 'weights'].includes(channel.target?.path)) throw Error('Unknown animation target path'); }
    if (animationClips.length < 16) animationClips.push({ index: i, name: String(a.name ?? `clip-${i}`).slice(0, 80), durationSeconds: duration });
  }
  const extensionsRequired = array(g.extensionsRequired, 'extensionsRequired', 32).map(x => String(x).slice(0, 80));
  const decoderExtensions = extensionsRequired.filter(x => ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'].includes(x));
  if (decoderExtensions.length) warning(`Configure matching loaders before rendering: ${decoderExtensions.join(', ')}. Model3D currently uses plain GLTFLoader.`);
  if (totalBytes > 3 * 1024 * 1024) warning('Model bundle exceeds 3 MiB first-load advisory; reuse, compress or simplify for mobile.');
  if (triangles > 100_000) warning('Model exceeds 100k declared triangles; profile draw calls/frame cost before delivery.');
  if (embeddedBytes) warning('Embedded data bytes are counted separately from source bytes (base64 already contributes to source size).');
  return {
    format: 'glTF 2.0', sha256: hash(source), bundleSha256: createHash('sha256').update(source).update([...resources.values()].sort((a, b) => a.file.localeCompare(b.file)).map(r => `${r.file}\0${r.sha256}`).join('\n')).digest('hex'), bytes: totalBytes, embeddedDecodedBytes: embeddedBytes,
    counts: { meshes: meshes.length, nodes: nodes.length, scenes: scenes.length, primitives, vertices, triangles, materials: materials.length, textures: textures.length, animations: animations.length },
    resources: [...resources.values()].slice(0, 16).map(r => ({ ...r, file: r.file.slice(0, 256), pathTruncated: r.file.length > 256 })), resourceCount: resources.size, resourcesTruncated: resources.size > 16,
    meshLocalBounds: meshBounds, boundsComplete, imageDimensions, animationClips, extensionsRequired, warnings,
    checked: 'Local containment, bounded bytes/work, GLB chunks, buffer/accessor ranges, primitive index ranges, node cycles, finite decoded positions and increasing animation times.',
    unverified: 'Full Khronos conformance, compressed/sparse payload decoding, world/skinned bounds, texture decode, runtime GPU cost, appearance and playback. Use the existing Three.js/Model3D renderer for pixels; scene_create accepts procedural scene JSON, not imported models.',
  };
}

/** Copy a validated self-contained local bundle, retaining relative references.
 * Fresh destination only. Failed staging is removed; a supplied source is never altered. */
export async function stageGltfBundle(source: string, destination: string, signal?: AbortSignal) {
  const before = await inspectGltf(source, signal), directory = path.dirname(await fs.realpath(source));
  const bytes = await readBounded(source, /\.glb$/i.test(source) ? GLTF_LIMITS.fileBytes : GLTF_LIMITS.jsonBytes, signal);
  if (hash(bytes) !== before.sha256) throw Error('Model changed during import; inspect again');
  const { document } = parseGltf(bytes, /\.glb$/i.test(source));
  const relatives = [...new Set([...array(document.buffers, 'buffers', 128), ...array(document.images, 'images', 128)].map(r => r.uri).filter(uri => typeof uri === 'string' && !uri.startsWith('data:')).map(uri => decodeURIComponent(uri)))];
  if (relatives.length > GLTF_LIMITS.resources) throw Error('Model import exceeds 128 resource references');
  await fs.mkdir(destination, { recursive: false, mode: 0o700 });
  try {
    let total = bytes.length;
    for (const relative of relatives) {
      signal?.throwIfAborted();
      const resolved = await fs.realpath(path.resolve(directory, relative));
      if (!containsPath(directory, resolved)) throw Error('Model resource escaped its directory during import');
      const resource = await readBounded(resolved, Math.min(GLTF_LIMITS.fileBytes, GLTF_LIMITS.totalBytes - total), signal);
      total += resource.length;
      const out = path.join(destination, relative);
      await fs.mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
      await fs.writeFile(out, resource, { flag: 'wx' });
    }
    const file = path.join(destination, path.basename(source));
    await fs.writeFile(file, bytes, { flag: 'wx' });
    return { path: file, report: await inspectGltf(file, signal) };
  } catch (error) { await fs.rm(destination, { recursive: true, force: true }); throw error; }
}
