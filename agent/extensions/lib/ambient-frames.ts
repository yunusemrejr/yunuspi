/** Frame-driven atmosphere over authored artwork. All spatial effects use
 * inspected mattes; the renderer preserves the subject instead of inventing it. */
export function ambientPlan(p: any) {
  const num = (key: string, fallback: number, min: number, max: number, integer = false) => {
    const n = p[key] ?? fallback;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw Error(`${key} must be ${min}..${max}${integer ? ' (integer)' : ''}`);
    return n;
  };
  const width = num('width', 1920, 64, 3840, true), height = num('height', 1080, 64, 2160, true);
  if (width % 2 || height % 2) throw Error('Delivery dimensions must be even');
  const requestedSeconds = num('seconds', 10, .25, 120), fps = num('fps', 24, 1, 60, true);
  const frames = Math.max(1, Math.round(requestedSeconds * fps)), seconds = frames / fps;
  const clouds = num('clouds', .75, 0, 1), rain = num('rain', .35, 0, 1), fog = num('fog', 0, 0, 1), reflections = num('reflections', 0, 0, 1);
  const skyline = p.skyline;
  if (skyline !== undefined && (!Array.isArray(skyline) || skyline.length < 2 || skyline.length > 64 || skyline.some((point, i) => !Array.isArray(point) || point.length !== 2 || point.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) || (i > 0 && point[0] <= skyline[i-1][0])) || skyline[0][0] !== 0 || skyline.at(-1)[0] !== 1)) throw Error('skyline needs 2..64 ordered [x,y] canvas fractions, from x:0 to x:1; white sky is above this boundary');
  if (p.skyMask && skyline) throw Error('Provide skyMask or skyline, not both');
  if (clouds > 0 && !p.skyMask && !skyline) throw Error('Cloud movement requires an inspected skyMask image or skyline: white sky, black stationary terrain/buildings. Set clouds:0 for rain only.');
  if (fog > 0 && !p.fogMask) throw Error('fog requires a full-canvas fogMask: white atmosphere, black subject/foreground');
  if (reflections > 0 && !p.reflectionMask) throw Error('reflections requires a full-canvas reflectionMask: white wet ground, black subject/sky');
  if (p.loop !== undefined && typeof p.loop !== 'boolean') throw Error('loop must be boolean');
  if(p.loop && frames<2)throw Error('A motion loop needs at least two frames');
  const cloudModel = p.cloudModel ?? 'evolve';
  if (!['drift','evolve'].includes(cloudModel)) throw Error('cloudModel must be drift or evolve');
  if (p.loop && cloudModel === 'drift' && clouds > 0) throw Error('A drifting photograph cannot guarantee a loop. Use cloudModel:evolve with loop:true.');
  const lightning = p.lightning ?? [];
  if (!Array.isArray(lightning) || lightning.length > 12 || lightning.some(t => typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t >= seconds)) throw Error('lightning needs at most 12 seconds within the clip');
  const framePixels = width * height * frames, maxFramePixels = num('maxFramePixels', 3_000_000_000, 4096, 60_000_000_000, true);
  return { width, height, seconds, fps, frames, clouds, rain, fog, reflections, skyline, loop: p.loop ?? false, loopSeconds: seconds, cloudModel,
    cloudScale: num('cloudScale', .8, .15, 3), cloudContrast: num('cloudContrast', .45, 0, 1), maskFeather:num('maskFeather',.04,0,.08), wind: num('wind', -.16, -.8, .8), seed: num('seed', 17, 0, 4294967295, true),
    cloudSpeed: num('cloudSpeed', 1.2, -10, 10), lightning, exposure: num('exposure', 0, -2, 1), crf: num('crf', 18, 1, 40, true), work: {framePixels,maxFramePixels,withinBudget:framePixels<=maxFramePixels} };
}
export function skylineMask(points: number[][], w: number, h: number) {
  const pixels = new Uint8Array(w*h*3); let edge = 0;
  for (let x = 0; x < w; x++) {
    const nx=x/Math.max(1,w-1);
    while(edge < points.length-2 && nx > points[edge+1][0]) edge++;
    const [a,b]=[points[edge],points[edge+1]], at=(nx-a[0])/(b[0]-a[0]), boundary=(a[1]+(b[1]-a[1])*at)*h;
    for(let y=0;y<Math.min(h,Math.ceil(boundary));y++) {
      const v=Math.round(255*Math.min(1,Math.max(0,(boundary-y)/Math.max(2,h/90))));
      pixels.fill(v,(y*w+x)*3,(y*w+x)*3+3);
    }
  }
  return pixels;
}
const wrap = (n: number, m: number) => ((n % m) + m) % m;
const clamp = (n: number, min = 0, max = 1) => Math.max(min, Math.min(max, n));
const hash = (x: number, y: number, seed: number) => {
  let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ seed;
  n = Math.imul(n ^ (n >>> 13), 1274126177); return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
};
const smooth = (x: number) => x*x*x*(x*(x*6-15)+10);
/** Feather inward only. Blurring a matte outward would paint protected
 * architecture and produce bright halos around a composited subject. */
export function featherMask(mask:Uint8Array,w:number,h:number,radius:number) {
  if(mask.length!==w*h*3 || !Number.isFinite(radius) || radius<0)throw Error('Invalid matte canvas or feather radius');
  if(radius===0)return Uint8Array.from(mask);
  const distance=Float32Array.from({length:w*h},(_,i)=>mask[i*3]===0?0:radius),diagonal=Math.SQRT2;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=y*w+x;let d=distance[i];if(x)d=Math.min(d,distance[i-1]+1);if(y)d=Math.min(d,distance[i-w]+1);if(x&&y)d=Math.min(d,distance[i-w-1]+diagonal);if(x<w-1&&y)d=Math.min(d,distance[i-w+1]+diagonal);distance[i]=d;
  }
  for(let y=h-1;y>=0;y--)for(let x=w-1;x>=0;x--){
    const i=y*w+x;let d=distance[i];if(x<w-1)d=Math.min(d,distance[i+1]+1);if(y<h-1)d=Math.min(d,distance[i+w]+1);if(x<w-1&&y<h-1)d=Math.min(d,distance[i+w+1]+diagonal);if(x&&y<h-1)d=Math.min(d,distance[i+w-1]+diagonal);distance[i]=d;
  }
  const out=new Uint8Array(mask.length);for(let i=0;i<distance.length;i++){const v=Math.round(mask[i*3]*smooth(Math.min(1,distance[i]/radius)));out.fill(v,i*3,i*3+3);}return out;
}
function noise(x: number, y: number, seed: number) {
  const ix=Math.floor(x), iy=Math.floor(y), u=smooth(x-ix), v=smooth(y-iy);
  const a=hash(ix,iy,seed), b=hash(ix+1,iy,seed), c=hash(ix,iy+1,seed), d=hash(ix+1,iy+1,seed);
  return a+(b-a)*u+(c-a)*v+(a-b-c+d)*u*v;
}
function fbm(x: number, y: number, seed: number) {
  let result=0, weight=.55;
  for(let i=0;i<4;i++){result+=weight*noise(x,y,seed+i*131);x=x*2.03+3.1;y=y*2.03-1.7;weight*=.45;}
  return result/.95899375;
}
/** A small smooth field sampled at delivery resolution. The time coordinate
 * travels around a circle for loops: it evolves and returns without a reset. */
function weatherField(w: number, h: number, scale: number, seed: number) {
  const gw=Math.min(240,Math.max(16,Math.ceil(w/8))), gh=Math.max(9,Math.ceil(gw*h/w));
  const values=new Float32Array((gw+1)*(gh+1));
  return { values, render(phase: number, travel: number) {
    const cx=Math.cos(phase)*travel, cy=Math.sin(phase)*travel;
    for(let y=0;y<=gh;y++)for(let x=0;x<=gw;x++){
      const nx=x/gw*4/scale, ny=y/gw*4/scale;
      const warp=noise(nx*.7+cx*.6,ny*.7+cy*.6,seed+91)-.5;
      values[y*(gw+1)+x]=fbm(nx+cx+warp*1.4,ny+cy+warp*.8,seed);
    }
  }, sample(x: number,y: number) {
    const fx=clamp(x/w)*gw, fy=clamp(y/h)*gh, ix=Math.min(gw-1,Math.floor(fx)), iy=Math.min(gh-1,Math.floor(fy)), u=fx-ix,v=fy-iy, at=iy*(gw+1)+ix;
    const a=values[at],b=values[at+1],c=values[at+gw+1],d=values[at+gw+2];return a+(b-a)*u+(c-a)*v+(a-b-c+d)*u*v;
  }};
}
const toLinear=Float32Array.from({length:256},(_,v)=>v/255<=.04045?v/255/12.92:((v/255+.055)/1.055)**2.4);
const toSrgb=Uint8Array.from({length:4097},(_,v)=>Math.round(255*(v/4096<=.0031308?v/4096*12.92:1.055*(v/4096)**(1/2.4)-.055)));
const encoded = (v: number) => toSrgb[Math.round(clamp(v)*4096)];
type Mattes = {fog?:Uint8Array;rain?:Uint8Array;reflection?:Uint8Array};
export function createAmbientFrames(base: Uint8Array, mask: Uint8Array | undefined, plan: ReturnType<typeof ambientPlan>, mattes: Mattes = {}) {
  const { width: w, height: h } = plan, bytes = w * h * 3;
  if (base.length !== bytes || [mask,...Object.values(mattes)].some(m=>m && m.length!==bytes)) throw Error('Plate and masks must match the RGB delivery canvas');
  if(plan.clouds && !mask)throw Error('Clouds require a decoded sky mask');
  if(plan.fog && !mattes.fog)throw Error('Fog requires a decoded fog mask');
  if(plan.reflections && !mattes.reflection)throw Error('Reflections require a decoded wet-ground mask');
  let seed = plan.seed;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const gain = 2 ** plan.exposure;
  const plate = Uint8Array.from(base, v => Math.min(255, Math.round(v * gain)));
  const sky: number[] = [], atmosphere: number[] = [], wet: number[] = [];
  for(let i=0;i<w*h;i++){if(mask?.[i*3] && plan.clouds)sky.push(i);if(mattes.fog?.[i*3] && plan.fog)atmosphere.push(i);if(mattes.reflection?.[i*3] && plan.reflections)wet.push(i);}
  const period=plan.loopSeconds ?? plan.seconds, evolving=(plan.cloudModel ?? 'drift')==='evolve';
  const field=weatherField(w,h,plan.cloudScale ?? .8,plan.seed), initial=new Float32Array(sky.length);
  field.render(0,.8);for(let n=0;n<sky.length;n++)initial[n]=field.sample(sky[n]%w,Math.floor(sky[n]/w));
  // Derive mist light from the actual plate rather than injecting a fixed hue.
  const mist=[0,0,0];let samples=0;
  for(let i=0;i<w*h;i+=Math.max(1,Math.floor(w*h/4096)))if(!mask || mask[i*3]>127){for(let c=0;c<3;c++)mist[c]+=toLinear[plate[i*3+c]];samples++;}
  for(let c=0;c<3;c++)mist[c]=(samples?mist[c]/samples:.15)*.55+.22;
  const drops = Array.from({ length: Math.round(plan.rain * 950) }, () => {
    const depth = random(), length=(3+depth**2*25)*h/1080, span=h+length*2;
    const requested=(160+depth**2*1050)*h/1080;
    const speed=plan.loop?Math.max(1,Math.round(requested*period/span))*span/period:requested;
    return { x: random()*w,y:random()*span-length,speed,length,span,width:depth>.83?2:1,alpha:(.025+depth**2*.18)*plan.rain,slant:plan.wind ?? -.16 };
  });
  const splashes=Array.from({length:28},()=>({x:random()*w,y:random()*h,phase:random(),cycle:1+Math.floor(random()*3),radius:(2+random()*7)*w/1920}));
  return (seconds: number) => {
    if(!Number.isFinite(seconds))throw Error('Frame time must be finite');
    const time=plan.loop?wrap(seconds,period):seconds;
    const phase=plan.loop?time/period*Math.PI*2:time*.12;
    const cloudPhase=phase*(plan.loop?Math.round(plan.cloudSpeed):plan.cloudSpeed);
    const frame = Buffer.from(plate);
    if(evolving || atmosphere.length)field.render(cloudPhase,.8);
    if(mask)for(let n=0;n<sky.length;n++){
      const pixel=sky[n],x=pixel%w,y=Math.floor(pixel/w),i=pixel*3;
      if(!evolving){
        const sx=wrap(x+time*plan.cloudSpeed*w/1920,w),lo=Math.floor(sx),hi=(lo+1)%w,a=sx-lo,j=(y*w+lo)*3,k=(y*w+hi)*3;
        const coverage=mask[i]/255*Math.min(mask[j],mask[k])/255*plan.clouds;
        for(let c=0;c<3;c++)frame[i+c]=Math.round(plate[i+c]+(plate[j+c]*(1-a)+plate[k+c]*a-plate[i+c])*coverage);
        continue;
      }
      const density=field.sample(x,y)-initial[n];
      const displacement=(Math.sin(cloudPhase)*12+density*28)*plan.cloudSpeed*w/1920;
      const sx=clamp(x+displacement,0,w-1),source=Math.floor(sx),coverage=mask[i]/255*Math.min(mask[(y*w+source)*3],mask[(y*w+Math.min(w-1,source+1))*3])/255*plan.clouds;
      const light=Math.exp(-density*(plan.cloudContrast ?? .45)*1.8);
      const j=(y*w+source)*3,k=(y*w+Math.min(w-1,source+1))*3,u=sx-source;
      for(let c=0;c<3;c++){
        const sampled=plate[j+c]*(1-u)+plate[k+c]*u,warped=plate[i+c]+(sampled-plate[i+c])*coverage;
        frame[i+c]=encoded(toLinear[Math.round(warped)]*(1+(light-1)*coverage));
      }
    }
    for(const pixel of atmosphere){
      const i=pixel*3,v=field.sample(pixel%w,Math.floor(pixel/w)),opacity=mattes.fog![i]/255*plan.fog*(.035+.15*clamp((v-.25)*2));
      for(let c=0;c<3;c++)frame[i+c]=encoded(toLinear[frame[i+c]]*(1-opacity)+mist[c]*opacity);
    }
    if(wet.length){
      const source=Buffer.from(frame);
      for(const pixel of wet){
        const x=pixel%w,y=Math.floor(pixel/w),i=pixel*3;
        const ripple=Math.sin(y/h*90+phase*2+Math.sin(x/w*11+phase))*1.6*w/1920;
        const sx=clamp(x+ripple,0,w-1),lo=Math.floor(sx),j=(y*w+lo)*3,k=(y*w+Math.min(w-1,lo+1))*3,u=sx-lo,coverage=mattes.reflection![i]/255*Math.min(mattes.reflection![j],mattes.reflection![k])/255*plan.reflections;
        for(let c=0;c<3;c++)frame[i+c]=Math.round(source[i+c]+(source[j+c]*(1-u)+source[k+c]*u-source[i+c])*coverage);
      }
      for(const splash of splashes){
        const p=wrap(time/(plan.loop?period:8)*splash.cycle+splash.phase,1);if(p>.35)continue;
        const radius=splash.radius*p/.35,opacity=(1-p/.35)*.12*plan.reflections*plan.rain;
        for(let a=0;a<24;a++){
          const angle=a/24*Math.PI*2,x=Math.round(splash.x+Math.cos(angle)*radius),y=Math.round(splash.y+Math.sin(angle)*radius*.3);
          if(x<0||y<0||x>=w||y>=h)continue;const i=(y*w+x)*3,alpha=opacity*mattes.reflection![i]/255;
          for(let c=0;c<3;c++)frame[i+c]=Math.round(frame[i+c]+(200-frame[i+c])*alpha);
        }
      }
    }
    for (const drop of drops) {
      const y=wrap(drop.y+time*drop.speed+drop.length,drop.span)-drop.length,x=wrap(drop.x+drop.slant*(y-drop.y),w);
      for (let d=0;d<drop.length;d++)for(let q=0;q<drop.width;q++){
        const px=Math.round(x-d*drop.slant)+q,py=Math.round(y-d);
        if(px<0||px>=w||py<0||py>=h)continue;
        const i=(py*w+px)*3,opacity=drop.alpha*Math.sin(Math.PI*d/drop.length)*(mattes.rain?mattes.rain[i]/255:1)/drop.width;
        for(let c=0;c<3;c++)frame[i+c]=Math.round(frame[i+c]+(215-frame[i+c])*opacity);
      }
    }
    const distance=(t:number)=>plan.loop?wrap(time-t+period/2,period)-period/2:time-t;
    const flash=Math.min(.075,plan.lightning.reduce((sum,t)=>sum+.055*Math.exp(-((distance(t)/.14)**2))+.022*Math.exp(-((distance(t+.22)/.1)**2)),0));
    if(flash>.0005)for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const i=(y*w+x)*3,opacity=flash*(1-.65*y/h);
      for(let c=0;c<3;c++)frame[i+c]=encoded(toLinear[frame[i+c]]*(1-opacity)+.79*opacity);
    }
    return frame;
  };
}
