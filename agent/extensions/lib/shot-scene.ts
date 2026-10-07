/** Bounded scene graph contract for video_shot's built-in Blender builder. */
import { number } from './media-process.ts';
export const SCENE_SHAPES = ['box', 'sphere', 'cylinder', 'torus', 'lathe', 'tube', 'text', 'image', 'phone', 'laptop', 'model', 'group'] as const;
export const OBJECT_EASES = ['linear', 'inOut', 'in', 'out', 'backOut'] as const;
const vector = (v: unknown, label: string, positive = false) => {
  if (!Array.isArray(v) || v.length !== 3 || v.some(n => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 1000 || (positive && n <= 0))) throw Error(`${label} needs three finite ${positive ? 'positive ' : ''}numbers within 1000`);
};
export function validateShotScene(spec: any, seconds: number) {
  if (!spec || !Array.isArray(spec.objects) || spec.objects.length < 1 || spec.objects.length > 48) throw Error('scene.objects needs 1..48 objects');
  const ids = new Set<string>();
  const screenPrefixes = new Set<string>();
  let instances = 0;
  for (const obj of spec.objects) {
    if (!obj || typeof obj.id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(obj.id) || ids.has(obj.id)) throw Error('Scene objects need distinct kebab-case ids');
    ids.add(obj.id);
    instances += obj.instances?.count ?? 1;
    if (instances > 192) throw Error('Native scene exceeds 192 shared instances; split the shot or author a bounded Blender geometry-node setup');
    if (['phone','laptop'].includes(obj.shape)) {
      const prefix = obj.screenPrefix ?? 'screen';
      if (typeof prefix !== 'string' || !/^[a-z][a-z0-9:-]{0,47}$/.test(prefix) || screenPrefixes.has(prefix)) throw Error('Devices need distinct screenPrefix names for their tracked corners');
      screenPrefixes.add(prefix);
    }
    if (obj.maps && ['model','group','phone','laptop'].includes(obj.shape)) throw Error('PBR maps apply to native surface forms; imported models retain authored textures and devices retain their finished material palette');
    if (!(SCENE_SHAPES as readonly string[]).includes(obj.shape)) throw Error(`Unsupported scene shape ${obj.shape}`);
    for (const key of ['position', 'rotation', 'size', 'scale']) if (obj[key] !== undefined) vector(obj[key], `${obj.id}.${key}`, key === 'size' || key === 'scale');
    if (obj.size && ['phone','laptop'].includes(obj.shape)) {
      const [w,d,h] = obj.size;
      const valid = obj.shape === 'phone' ? h/w >= 1.3 && h/w <= 2.5 && d/w >= .03 && d/w <= .2 : h/w >= .35 && h/w <= .85 && d/w >= .4 && d/w <= .9;
      if (!valid) throw Error(`${obj.id}.size is the whole device [width,depth,height] in metres, including an open laptop lid. Omit size for authored proportions; use scale:[s,s,s] for uniform scaling.`);
    }
    if (obj.color !== undefined && !/^#[0-9a-f]{6}$/i.test(obj.color)) throw Error(`${obj.id}.color must be #rrggbb`);
    if (obj.material !== undefined && !['clay', 'satin', 'metal', 'glass', 'glow'].includes(obj.material)) throw Error(`${obj.id}.material is invalid`);
    if (obj.roughness !== undefined) number(obj.roughness, .4, 0, 1, 'roughness');
    if (obj.bevel !== undefined) number(obj.bevel, .02, 0, .2, 'bevel');
    if (['model', 'image'].includes(obj.shape) && (typeof obj.path !== 'string' || !obj.path.trim())) throw Error(`${obj.shape} object needs a local asset path`);
    if (obj.shape === 'image' && obj.maps) throw Error('image cards use path for their RGBA texture; PBR maps belong on surface forms');
    if (obj.shape !== 'image' && (obj.opacity !== undefined || obj.unlit !== undefined)) throw Error('opacity/unlit apply to image cards');
    if (obj.opacity !== undefined) number(obj.opacity, 1, 0, 1, 'opacity');
    if (obj.unlit !== undefined && typeof obj.unlit !== 'boolean') throw Error('unlit must be boolean');
    if (obj.instances) {
      const instance = obj.instances;
      if (['group', 'phone', 'laptop', 'model'].includes(obj.shape)) throw Error('Native shared instances apply to surface forms, text and image cards; use authored geometry nodes for complex rigs');
      if (!Number.isInteger(instance.count) || instance.count < 1 || instance.count > 128) throw Error('instances.count must be 1..128, including the original');
      if (!['line', 'grid', 'radial'].includes(instance.layout ?? 'line')) throw Error('instances.layout must be line, grid or radial');
      if (instance.spacing !== undefined) vector(instance.spacing, 'instances.spacing');
      if (instance.columns !== undefined && (!Number.isInteger(instance.columns) || instance.columns < 1 || instance.columns > 64)) throw Error('instances.columns must be 1..64');
      number(instance.radius, 2, .01, 100, 'instances.radius');
      number(instance.stagger, 0, 0, seconds, 'instances.stagger');
      if ((instance.count - 1) * (instance.stagger ?? 0) >= seconds) throw Error('Instance stagger must leave the final copy inside the shot');
      number(instance.startAngle, 0, -360, 360, 'instances.startAngle');
      number(instance.sweep, 360, .01, 360, 'instances.sweep');
    }
    if (obj.shape === 'text' && (typeof obj.text !== 'string' || !obj.text.trim() || obj.text.length > 120)) throw Error('text object needs 1..120 characters');
    if (obj.shape === 'lathe' || obj.shape === 'tube') {
      const count = obj.shape === 'lathe' ? 2 : 3;
      if (!Array.isArray(obj.points) || obj.points.length < 2 || obj.points.length > 128 || obj.points.some((p: any) => !Array.isArray(p) || p.length !== count || p.some((n: any) => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 100))) throw Error(`${obj.shape} needs 2..128 finite ${count}D points`);
      if (obj.shape === 'lathe' && obj.points.some((p: any) => p[0] < 0)) throw Error('lathe radii must be nonnegative');
    }
    if (obj.radius !== undefined) number(obj.radius, .03, .001, 10, 'radius');
    if (obj.motion !== undefined) {
      if (!Array.isArray(obj.motion) || obj.motion.length < 1 || obj.motion.length > 32) throw Error('Object motion needs 1..32 keys');
      let last = -1;
      for (const key of obj.motion) {
        if (!key || typeof key.t !== 'number' || !Number.isFinite(key.t) || key.t <= last || key.t < 0 || key.t > seconds) throw Error('Object motion keys must increase inside shot seconds');
        if (key.ease !== undefined && !(OBJECT_EASES as readonly string[]).includes(key.ease)) throw Error('Unsupported object motion ease');
        for (const field of ['position', 'rotation', 'scale']) if (key[field] !== undefined) vector(key[field], `motion.${field}`, field === 'scale');
        last = key.t;
      }
    }
  }
  for (const obj of spec.objects) {
    if (obj.parent && spec.objects.find((p: any) => p.id === obj.parent)?.instances) throw Error('Shared instance forms cannot parent separately controlled scene objects; use a group rig');
    const visited = new Set([obj.id]); let parent = obj.parent;
    while (parent) {
      if (!ids.has(parent) || visited.has(parent)) throw Error(`Missing or cyclic parent for ${obj.id}`);
      visited.add(parent); parent = spec.objects.find((p: any) => p.id === parent).parent;
    }
  }
  return spec;
}

export function validateCameraPath(keys: any, seconds: number) {
  if (!Array.isArray(keys) || keys.length < 2 || keys.length > 32) throw Error('cameraPath needs 2..32 keys');
  let last = -1;
  for (const key of keys) {
    if (!key || typeof key.t !== 'number' || !Number.isFinite(key.t) || key.t < 0 || key.t > seconds || key.t <= last) throw Error('Camera keys must increase inside shot seconds');
    vector(key.position, 'camera.position'); vector(key.target, 'camera.target');
    if (Math.hypot(...key.position.map((v: number, i: number) => v - key.target[i])) < .001) throw Error('Camera position and target must differ');
    if (key.lensMm !== undefined) number(key.lensMm, 60, 18, 200, 'camera.lensMm');
    if (key.ease !== undefined && !(OBJECT_EASES as readonly string[]).includes(key.ease)) throw Error('Unsupported camera motion ease');
    last = key.t;
  }
  if (keys[0].t !== 0) throw Error('cameraPath must start at t:0');
  return keys;
}
