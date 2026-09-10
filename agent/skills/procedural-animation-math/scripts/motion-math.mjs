import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
function unitInterval(u) { if (!Number.isFinite(u) || u < 0 || u > 1) throw new RangeError('Parameter must be in [0,1]'); }
function vector(v, n) { if (!Array.isArray(v) || v.length !== n || !v.every(Number.isFinite)) throw new RangeError(`Expected ${n} finite components`); }
export function cubic(points, u) {
  unitInterval(u);
  if (!Array.isArray(points) || points.length !== 4 || !Array.isArray(points[0])) throw new RangeError('Expected four control points');
  const n = points[0].length;
  if (n < 1 || n > 4) throw new RangeError('Expected 1–4 dimensions');
  points.forEach(p => vector(p, n));
  const [a,b,c,d] = points, r = 1-u;
  const result = {
    position: a.map((x,i) => r**3*x+3*r*r*u*b[i]+3*r*u*u*c[i]+u**3*d[i]),
    derivative: a.map((x,i) => 3*(r*r*(b[i]-x)+2*r*u*(c[i]-b[i])+u*u*(d[i]-c[i]))),
    secondDerivative: a.map((x,i) => 6*(r*(c[i]-2*b[i]+x)+u*(d[i]-2*c[i]+b[i])))
  };
  Object.values(result).forEach(v => vector(v,n)); return result;
}
function normalize(q) {
  vector(q,4); const scale = Math.max(...q.map(Math.abs));
  if (scale === 0) throw new RangeError('Zero quaternion');
  const scaled = q.map(x=>x/scale), norm = Math.hypot(...scaled);
  return scaled.map(x=>x/norm);
}
export function slerp(a, b, u) {
  unitInterval(u); a=normalize(a); b=normalize(b);
  let dot=a.reduce((s,x,i)=>s+x*b[i],0);
  if(dot<0) { b=b.map(x=>-x); dot=-dot; }
  dot=Math.min(1,Math.max(-1,dot));
  if(dot>0.9995) return normalize(a.map((x,i)=>(1-u)*x+u*b[i]));
  const theta=Math.acos(dot), denominator=Math.sin(theta);
  const w0=Math.sin((1-u)*theta)/denominator, w1=Math.sin(u*theta)/denominator;
  return normalize(a.map((x,i)=>w0*x+w1*b[i]));
}
export function quintic(u) {
  unitInterval(u);
  return { value:u**3*(10+u*(-15+6*u)), derivative:30*u*u*(u-1)**2, secondDerivative:60*u*(2*u*u-3*u+1) };
}
export function selfTest() {
  const close=(a,b,eps=1e-8)=>assert.ok(Math.abs(a-b)<=eps,`${a} != ${b}`);
  const points=[[0,0],[1,0],[1,1],[2,1]], result=cubic(points,0.5);
  assert.deepEqual(result.position,[1,0.5]); assert.deepEqual(result.derivative,[1.5,1.5]);
  for (const u of [0.1,0.37,0.8]) {
    const h=1e-5, lo=cubic(points,u-h), hi=cubic(points,u+h), at=cubic(points,u);
    at.derivative.forEach((x,i)=>close(x,(hi.position[i]-lo.position[i])/(2*h)));
    at.secondDerivative.forEach((x,i)=>close(x,(hi.derivative[i]-lo.derivative[i])/(2*h)));
  }
  const half=slerp([0,0,0,1],[0,0,1,0],0.5); close(half[2],Math.SQRT1_2); close(half[3],Math.SQRT1_2);
  for (const u of [0,0.25,0.5,0.75,1]) {
    const q=slerp([0,0,0,1],[0,0,0,-1],u); close(Math.abs(q[3]),1); close(Math.hypot(...q),1);
  }
  close(slerp([0,0,0,Number.MAX_VALUE],[0,0,Number.MAX_VALUE,0],0.5)[2],Math.SQRT1_2);
  assert.equal(quintic(0).value,0); assert.equal(quintic(1).value,1);
  for (const u of [0,1]) { assert.equal(quintic(u).derivative,0); assert.equal(quintic(u).secondDerivative,0); }
  close(quintic(0.5).derivative*100/2,93.75);
  assert.throws(()=>slerp([0,0,0,0],[0,0,0,1],0.5)); assert.throws(()=>quintic(NaN));
  return 'motion-math: derivative differences, endpoint, quaternion and easing invariants passed';
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if(process.argv[2]!=='--self-test') { console.error('Usage: node motion-math.mjs --self-test; import exports for calculations'); process.exitCode=2; }
  else console.log(selfTest());
}
