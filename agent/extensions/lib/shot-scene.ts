/** Bounded scene graph contract for video_shot's built-in Blender builder. */
import { number } from './media-process.ts';
export const SCENE_SHAPES = ['box', 'sphere', 'cylinder', 'torus', 'lathe', 'tube', 'text', 'phone', 'laptop', 'model', 'group', 'image-plane'] as const;
const vector = (v: unknown, label: string, positive = false) => {
  if (!Array.isArray(v) || v.length !== 3 || v.some(n => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 1000 || (positive && n <= 0))) throw Error(`${label} needs three finite ${positive ? 'positive ' : ''}numbers within 1000`);
};
export function validateShotScene(spec: any, seconds: number) {
  if (!spec || !Array.isArray(spec.objects) || spec.objects.length < 1 || spec.objects.length > 48) throw Error('scene.objects needs 1..48 objects');
  const ids = new Set<string>();
  const screenPrefixes = new Set<string>();
  for (const obj of spec.objects) {
    if (!obj || typeof obj.id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(obj.id) || ids.has(obj.id)) throw Error('Scene objects need distinct kebab-case ids');
    ids.add(obj.id);
    if (['phone','laptop'].includes(obj.shape)) {
      const prefix = obj.screenPrefix ?? 'screen';
      if (typeof prefix !== 'string' || !/^[a-z][a-z0-9:-]{0,47}$/.test(prefix) || screenPrefixes.has(prefix)) throw Error('Devices need distinct screenPrefix names for their tracked corners');
      screenPrefixes.add(prefix);
    }
    if (obj.maps && ['model','group','phone','laptop'].includes(obj.shape)) throw Error('PBR maps apply to native surface forms; imported models retain authored textures and devices retain their finished material palette');
    if (!(SCENE_SHAPES as readonly string[]).includes(obj.shape)) throw Error(`Unsupported scene shape ${obj.shape}`);
    if (obj.role !== undefined && !['hero','support','background'].includes(obj.role)) throw Error(`${obj.id}.role must be hero, support or background`);
    if (obj.shape === 'image-plane' && (typeof obj.image !== 'string' || !obj.image.trim())) throw Error('image-plane needs image: a local artwork, texture or cutout path');
    if (obj.lit !== undefined && (obj.shape !== 'image-plane' || typeof obj.lit !== 'boolean')) throw Error('lit is a boolean for image-plane surfaces only');
    if (obj.shape === 'image-plane' && obj.maps) throw Error('image-plane uses image RGBA; apply PBR maps to native surface forms instead');
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
    if (obj.shape === 'model' && (typeof obj.path !== 'string' || !obj.path.trim())) throw Error('model object needs path to an imported asset');
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
        for (const field of ['position', 'rotation', 'scale']) if (key[field] !== undefined) vector(key[field], `motion.${field}`, field === 'scale');
        last = key.t;
      }
    }
  }
  for (const obj of spec.objects) {
    const visited = new Set([obj.id]); let parent = obj.parent;
    while (parent) {
      if (!ids.has(parent) || visited.has(parent)) throw Error(`Missing or cyclic parent for ${obj.id}`);
      visited.add(parent); parent = spec.objects.find((p: any) => p.id === parent).parent;
    }
  }
  return spec;
}
