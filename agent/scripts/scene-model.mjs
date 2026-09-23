// Versioned, data-only local scene format. The renderer never executes scene input.
export const SCENE_LIMITS = Object.freeze({ objects: 64, lights: 4, keys: 512, frames: 900, pixelFrames: 900_000_000, jsonBytes: 256 * 1024 });
const styles = ['studio', 'clay', 'toon', 'wireframe'];
const geometries = ['box', 'sphere', 'torus', 'torusKnot', 'cone', 'cylinder', 'icosahedron', 'plane', 'group'];
function object(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw Error(`Unknown ${name} field: ${key}`);
  return value;
}
function finite(value, fallback, min, max, name) {
  const n = value === undefined ? fallback : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw Error(`${name} must be ${min}..${max}`);
  return n;
}
function integer(value, fallback, min, max, name) {
  const n = finite(value, fallback, min, max, name);
  if (!Number.isInteger(n)) throw Error(`${name} must be an integer`);
  return n;
}
function vec(value, fallback, name, min = -100, max = 100) {
  const v = value === undefined ? fallback : value;
  if (!Array.isArray(v) || v.length !== 3) throw Error(`${name} must contain three numbers`);
  return v.map(n => finite(n, undefined, min, max, name));
}
function color(value, fallback) {
  const c = value ?? fallback;
  if (typeof c !== 'string' || !/^#[a-f\d]{6}$/i.test(c)) throw Error('Colors must be six-digit hex, such as #aabbcc');
  return c;
}
function choice(value, fallback, choices, name) {
  const v = value ?? fallback;
  if (!choices.includes(v)) throw Error(`${name} must be ${choices.join(', ')}`);
  return v;
}
function label(value, fallback, max = 80) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f]/.test(value)) throw Error(`Text must be at most ${max} printable characters`);
  return value;
}
export function validateScene(input) {
  const s = object(input, ['version', 'title', 'duration', 'fps', 'width', 'height', 'style', 'background', 'exposure', 'camera', 'lights', 'objects', 'tracks'], 'scene');
  if (s.version !== undefined && s.version !== 1) throw Error('Unsupported scene version; use version 1');
  const duration = finite(s.duration, 6, 0.1, 30, 'duration');
  const fps = integer(s.fps, 24, 1, 60, 'fps');
  const width = integer(s.width, 1280, 64, 1920, 'width'), height = integer(s.height, 720, 64, 1080, 'height');
  if (width % 2 || height % 2) throw Error('Scene width and height must be even');
  const frames = Math.ceil(duration * fps);
  if (frames > SCENE_LIMITS.frames || frames * width * height > SCENE_LIMITS.pixelFrames) throw Error('Scene exceeds frame/pixel work budget; reduce resolution, fps or duration');
  const camera = object(s.camera ?? {}, ['position', 'target', 'fov'], 'camera');
  const normalizedCamera = { position: vec(camera.position, [5, 3.5, 7], 'camera position'), target: vec(camera.target, [0, 0.5, 0], 'camera target'), fov: finite(camera.fov, 40, 15, 100, 'camera fov') };
  if (normalizedCamera.position.every((v, i) => v === normalizedCamera.target[i])) throw Error('Camera position and target must differ');
  if (!Array.isArray(s.objects) || !s.objects.length || s.objects.length > SCENE_LIMITS.objects) throw Error('Scene needs 1..64 objects');
  const ids = new Set();
  const objects = s.objects.map((raw, i) => {
    const o = object(raw, ['id', 'parent', 'geometry', 'position', 'rotation', 'scale', 'color', 'roughness', 'metalness', 'opacity'], `object ${i}`);
    if (typeof o.id !== 'string' || !/^[a-zA-Z][\w-]{0,47}$/.test(o.id) || o.id === 'camera' || ids.has(o.id)) throw Error('Object IDs must be unique identifiers (camera is reserved)');
    ids.add(o.id);
    if (o.parent !== undefined && (typeof o.parent !== 'string' || o.parent === o.id)) throw Error('Invalid object parent');
    return { id: o.id, ...(o.parent ? { parent: o.parent } : {}), geometry: choice(o.geometry, 'box', geometries, 'geometry'), position: vec(o.position, [0, 0, 0], 'position'), rotation: vec(o.rotation, [0, 0, 0], 'rotation', -1000, 1000), scale: vec(o.scale, [1, 1, 1], 'scale', 0.01, 40), color: color(o.color, '#d77d55'), roughness: finite(o.roughness, 0.38, 0, 1, 'roughness'), metalness: finite(o.metalness, 0.1, 0, 1, 'metalness'), opacity: finite(o.opacity, 1, 0.05, 1, 'opacity') };
  });
  const byId = new Map(objects.map(o => [o.id, o]));
  for (const o of objects) {
    const seen = new Set([o.id]); let parent = o.parent;
    while (parent) {
      if (!byId.has(parent) || seen.has(parent)) throw Error('Object hierarchy has an unknown parent or cycle');
      seen.add(parent); parent = byId.get(parent).parent;
    }
  }
  const rawLights = s.lights ?? [{ type: 'hemisphere', color: '#e8efff', ground: '#645867', intensity: 1.8 }, { type: 'directional', color: '#fff0dd', intensity: 4, position: [4, 7, 5] }, { type: 'point', color: '#81bfff', intensity: 35, position: [-4, 3, -3] }];
  if (!Array.isArray(rawLights) || !rawLights.length || rawLights.length > SCENE_LIMITS.lights) throw Error('Use 1..4 lights');
  const lights = rawLights.map(raw => {
    const l = object(raw, ['type', 'color', 'ground', 'position', 'intensity'], 'light');
    return { type: choice(l.type, 'directional', ['hemisphere', 'directional', 'point'], 'light type'), color: color(l.color, '#ffffff'), ground: color(l.ground, '#545464'), position: vec(l.position, [4, 7, 5], 'light position'), intensity: finite(l.intensity, 2, 0, 100, 'light intensity') };
  });
  const rawTracks = s.tracks ?? [];
  if (!Array.isArray(rawTracks) || rawTracks.length > 128) throw Error('Use at most 128 animation tracks');
  const lanes = new Set(); let keyCount = 0;
  const tracks = rawTracks.map(raw => {
    const t = object(raw, ['target', 'property', 'keys'], 'track');
    if (t.target !== 'camera' && !ids.has(t.target)) throw Error('Animation target must name a scene object or camera');
    const property = choice(t.property, 'position', t.target === 'camera' ? ['position', 'target', 'fov'] : ['position', 'rotation', 'scale'], 'track property');
    const lane = `${t.target}/${property}`;
    if (lanes.has(lane)) throw Error('Use one animation track per target/property');
    lanes.add(lane);
    if (!Array.isArray(t.keys) || t.keys.length < 2 || t.keys.length > 64 || (keyCount += t.keys.length) > SCENE_LIMITS.keys) throw Error('Use 2..64 keys per track and at most 512 keys total');
    let previous = -1;
    const keys = t.keys.map(rawKey => {
      const k = object(rawKey, ['time', 'value', 'ease'], 'key');
      const time = finite(k.time, undefined, 0, duration, 'key time');
      if (time <= previous) throw Error('Key times must be strictly increasing');
      previous = time;
      const value = property === 'fov' ? finite(k.value, undefined, 15, 100, 'fov') : vec(k.value, undefined, 'key value', property === 'scale' ? 0.01 : -1000, property === 'scale' ? 40 : 1000);
      return { time, value, ease: choice(k.ease, 'smooth', ['linear', 'smooth', 'hold'], 'ease') };
    });
    return { target: t.target, property, keys };
  });
  return { version: 1, title: label(s.title, 'Local 3D study'), duration, fps, width, height, style: choice(s.style, 'studio', styles, 'style'), background: color(s.background, '#142132'), exposure: finite(s.exposure, 1, 0.1, 3, 'exposure'), camera: normalizedCamera, lights, objects, tracks };
}

/** Interpolation uses absolute time and never accumulated wall-clock deltas. */
export function sampleKeys(keys, time) {
  if (time <= keys[0].time) return keys[0].value;
  const last = keys.at(-1);
  if (time >= last.time) return last.value;
  const i = keys.findIndex(k => k.time > time), a = keys[i - 1], b = keys[i];
  let u = (time - a.time) / (b.time - a.time);
  if (a.ease === 'hold') u = 0;
  else if (a.ease === 'smooth') u = u * u * (3 - 2 * u);
  return Array.isArray(a.value) ? a.value.map((v, j) => v + (b.value[j] - v) * u) : a.value + (b.value - a.value) * u;
}

export function scenePreset(name = 'orbital', style = 'studio') {
  if (!['orbital', 'kinetic', 'sculpture'].includes(name)) throw Error('preset must be orbital, kinetic or sculpture');
  const objects = [
    { id: 'ground', geometry: 'plane', rotation: [-Math.PI / 2, 0, 0], position: [0, -1.25, 0], scale: [30, 30, 1], color: '#152437', roughness: 0.9 },
    { id: 'plinth', geometry: 'cylinder', position: [0, -1, 0], scale: [2.3, 0.4, 2.3], color: '#274059', roughness: 0.65 },
    { id: 'hero', geometry: name === 'sculpture' ? 'torusKnot' : name === 'kinetic' ? 'icosahedron' : 'sphere', scale: [1.25, 1.25, 1.25], color: '#e4b26c', metalness: 0.65, roughness: 0.24 },
    { id: 'orbit', geometry: 'group', rotation: [0.4, 0, 0.25] },
    { id: 'ring', parent: 'orbit', geometry: 'torus', scale: [2.25, 2.25, 2.25], color: '#8ab9c9', metalness: 0.55, roughness: 0.25 },
    { id: 'satellite', parent: 'orbit', geometry: 'sphere', position: [2.3, 0, 0], scale: [0.28, 0.28, 0.28], color: '#ef7556' },
  ];
  if (name === 'kinetic') for (let i = 0; i < 7; i++) objects.push({ id: `bar${i}`, geometry: 'box', position: [(i - 3) * 0.55, -0.4, -2], scale: [0.22, 0.6 + (i % 3) * 0.4, 0.22], color: ['#e4b26c', '#8ab9c9', '#ef7556'][i % 3] });
  const tracks = [
    { target: 'hero', property: 'rotation', keys: [{ time: 0, value: [0, 0, 0], ease: 'linear' }, { time: 6, value: [0, Math.PI * 2, 0] }] },
    { target: 'orbit', property: 'rotation', keys: [{ time: 0, value: [0.4, 0, 0.25], ease: 'linear' }, { time: 6, value: [0.4, Math.PI * 2, 0.25] }] },
    { target: 'camera', property: 'position', keys: [{ time: 0, value: [6, 3.2, 7] }, { time: 3, value: [4.5, 2.3, 8] }, { time: 6, value: [6, 3.2, 7] }] },
  ];
  if (name === 'kinetic') for (let i = 0; i < 7; i++) tracks.push({ target: `bar${i}`, property: 'scale', keys: [0, 1.5, 3, 4.5, 6].map((time, j) => ({ time, value: [0.22, 0.6 + ((i + j) % 3) * 0.6, 0.22] })) });
  return validateScene({ version: 1, title: { orbital: 'ORBIT / a study in balance', kinetic: 'PULSE / kinetic geometry', sculpture: 'FORM / continuous sculpture' }[name], style, objects, tracks });
}
