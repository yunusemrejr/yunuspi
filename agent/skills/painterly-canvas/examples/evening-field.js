/*
 * Example scene: a field above the sea at dusk. Moon and stars, sunset cumulus,
 * power lines, pampas grass, cosmos and fireflies. Draws onto a canvas of any
 * size with a portrait aspect around 9:15.5.
 */
function scene(canvas, seed = 7) {
  const P = Paint, ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height, s = W / 1080;
  const r = P.rng(seed);
  const horizon = H * 0.615;

  // Sky: night indigo at the top, through blue and lilac, to a pink and peach horizon.
  const skyRamp = P.ramp([[0, '#1a1a4c'], [0.22, '#262e74'], [0.45, '#34489a'], [0.62, '#4a69ad'], [0.76, '#7a76b8'], [0.88, '#c97aa4'], [0.95, '#ee9a92'], [1, '#f7b38a']]);
  P.sky(ctx, W, { bottom: horizon, ramp: skyRamp, seed: seed + 1, scale: s });
  P.stars(ctx, W, { top: 0, bottom: H * 0.42, count: 520, seed: seed + 2, scale: s,
    sparkles: [[W * 0.86, H * 0.08, 13], [W * 0.38, H * 0.13, 10], [W * 0.53, H * 0.045, 9], [W * 0.66, H * 0.16, 12], [W * 0.62, H * 0.2, 8], [W * 0.1, H * 0.05, 7]] });
  P.moon(ctx, W * 0.69, H * 0.1, 46 * s, { tilt: -0.75, phase: 0.45 });

  // Clouds: a cooler lilac cumulus behind on the right, the big sunlit one in front on the left.
  const coolRamp = P.ramp([[0, '#3a3f8f'], [0.25, '#5d5aae'], [0.45, '#8a76c4'], [0.62, '#b38fcf'], [0.78, '#d9a6cc'], [0.9, '#efc0c4'], [1, '#f9dccf']]);
  P.cumulus(ctx, { x: W * 0.84, base: H * 0.6, width: W * 0.64, height: H * 0.4, scale: s, seed: seed + 3, bubbles: 170,
    towers: [{ at: 0.3, h: 0.95, w: 0.5 }, { at: 0.75, h: 0.6, w: 0.5 }], ramp: coolRamp, light: [-0.8, -0.2, 0.6], ao: 0.3 });
  const warmRamp = P.ramp([[0, '#6a4596'], [0.18, '#8a4ea2'], [0.34, '#b0549e'], [0.48, '#dc6a8c'], [0.6, '#ec8a82'], [0.72, '#f4a986'], [0.85, '#f9cc9f'], [1, '#fff0d0']]);
  P.cumulus(ctx, { x: W * 0.36, base: H * 0.585, width: W * 1.0, height: H * 0.44, scale: s, seed: seed + 4, bubbles: 330, baseSize: 0.09,
    towers: [{ at: 0.18, h: 0.72, w: 0.4 }, { at: 0.42, h: 1, w: 0.42 }, { at: 0.7, h: 0.82, w: 0.42 }, { at: 0.9, h: 0.45, w: 0.3 }],
    ramp: warmRamp, light: [-0.75, -0.15, 0.65], ao: 0.4,
    tint: (x) => ['#7d74c8', P.smooth(W * 0.45, W * 0.9, x) * 0.35] });

  // Horizon: glow band, far headland, sea with a pink sheen near the horizon.
  P.band(ctx, W, horizon - 12 * s, 90 * s, '#f6a28c', 0.55);
  P.ridge(ctx, W * 0.32, W * 1.05, horizon + 2 * s, 34 * s, '#8a6fa6', seed + 5, 0.9);
  const seaRamp = P.ramp([[0, '#f0a59b'], [0.18, '#c99ab4'], [0.4, '#8f9fc4'], [0.7, '#5f93b5'], [1, '#3f6e98']]);
  P.sea(ctx, W, { top: horizon, bottom: H * 0.84, ramp: seaRamp, seed: seed + 6, scale: s,
    glints: [{ x: W * 0.3, y: horizon + 6 * s, h: H * 0.09, w: 40 * s, n: 70, color: '#ffd9b8' }, { x: W * 0.02, y: H * 0.665, h: 30 * s, w: 10 * s, n: 18, color: '#ff8f8a' }] });
  // a small ferry
  ctx.fillStyle = P.css(P.hex('#d9d6ee')); ctx.fillRect(W * 0.4, H * 0.643, 70 * s, 9 * s);
  ctx.fillStyle = P.css(P.hex('#3d3f7a')); ctx.fillRect(W * 0.405, H * 0.648, 62 * s, 4 * s);
  for (let i = 0; i < 6; i++) { ctx.fillStyle = P.css(P.hex('#ffe3a0')); ctx.fillRect(W * 0.41 + i * 9 * s, H * 0.644, 3 * s, 2 * s); }

  // Town on the lower shore, left.
  const townRamp = P.ramp([[0, '#6f5c9e'], [0.4, '#4b427f'], [1, '#2b2a58']]);
  P.town(ctx, { x0: 0, x1: W * 0.6, yTop: (x) => H * 0.708 + (x / W) * H * 0.03, yBottom: H * 0.8, ramp: townRamp, seed: seed + 7, scale: s, lights: 230 });

  // Poles and wires (bases are hidden by the meadow drawn next).
  const wireCol = '#1e1f3c';
  const A = P.pole(ctx, W * 0.68, H * 0.475, H * 0.82, 9 * s, wireCol, { arm: 80 * s });
  const B = P.pole(ctx, W * 0.17, H * 0.635, H * 0.86, 6 * s, wireCol, { arm: 52 * s });
  P.wire(ctx, A.right, [W * 1.05, H * 0.455], 18 * s, 2 * s, wireCol);
  P.wire(ctx, A.r2, [W * 1.05, H * 0.47], 22 * s, 2 * s, wireCol);
  P.wire(ctx, A.right, [W * 1.05, H * 0.5], 30 * s, 1.6 * s, wireCol);
  const w1 = P.wire(ctx, A.left, B.left, 55 * s, 1.8 * s, wireCol);
  P.wire(ctx, A.l2, B.r2, 50 * s, 1.8 * s, wireCol);
  P.wire(ctx, A.r2, B.right, 46 * s, 1.6 * s, wireCol);
  P.wire(ctx, B.left, [-W * 0.05, H * 0.72], 26 * s, 1.5 * s, wireCol);
  P.wire(ctx, B.right, [-W * 0.05, H * 0.75], 30 * s, 1.5 * s, wireCol);
  for (const t of [0.22, 0.26, 0.58]) { const p = w1(t); P.bird(ctx, p.x, p.y, 7 * s, wireCol); }

  // Meadow: a hill rising to the right, grass growing taller toward the viewer.
  const grassRamp = P.ramp([[0, '#0f1f24'], [0.25, '#1b3237'], [0.5, '#2b4a4a'], [0.75, '#46635e'], [1, '#7d8a8a']]);
  const top = (x) => H * 0.79 - P.smooth(W * 0.25, W * 0.95, x) * H * 0.105 + Math.sin(x / (W * 0.13)) * 6 * s;
  P.meadow(ctx, W, { top, bottom: H, ramp: grassRamp, seed: seed + 8, scale: s, rows: 60, density: 0.9, tipLight: ['#b9a6d6', 0.45] });

  // Small far cosmos scattered in the middle distance.
  const pinks = ['#e98cc4', '#d978b8', '#f2b2d6', '#c792d9', '#f4f0f6'];
  for (let i = 0; i < 160; i++) {
    const x = r() * W, y = top(x) + 20 * s + Math.pow(r(), 0.8) * (H * 0.93 - top(x)), d = (y - H * 0.7) / (H * 0.3);
    P.cosmos(ctx, { x, y, r: (4 + 12 * d) * s, color: r.pick(pinks), tilt: r.range(0.1, 0.6), rot: r.range(-0.5, 0.5), seed: seed + 100 + i, petals: 8 });
  }

  // Pampas plumes, back to front.
  const plumes = [
    [0.06, 0.93, 0.22, 60], [0.22, 0.97, 0.3, 90], [0.31, 0.99, 0.38, 140], [0.44, 0.95, 0.26, 90], [0.6, 1.0, 0.42, 170],
    [0.7, 0.9, 0.24, 80], [0.8, 0.98, 0.36, 150], [0.88, 1.0, 0.3, 120], [0.95, 0.93, 0.28, 90],
  ];
  plumes.sort((a, b) => a[1] - b[1]);
  plumes.forEach(([px, py, ph, lean], i) => P.plume(ctx, { x: W * px, y: H * py, height: H * ph, lean: lean * s, scale: s, seed: seed + 200 + i, strands: 260 + Math.round(ph * 500), droop: 1.1, fluff: 1.15, start: 0.5, color: '#f1d9c4', shade: '#8f7f9f' }));

  // Front grass blades over the plume stems, then big foreground flowers.
  const fr = P.rng(seed + 9);
  for (let i = 0; i < 900; i++) {
    const x = fr() * W, y = H * (0.9 + fr() * 0.12), h = fr.range(60, 260) * s, lean = fr.range(-0.2, 0.5) * h;
    P.blade(ctx, x, y, x + lean * 0.2, y - h * 0.6, x + lean, y - h, fr.range(2, 6) * s, P.jitter(grassRamp(fr.range(0.05, 0.55)), fr, 6), 0.95);
  }
  const big = [[0.05, 0.985, 46, '#e98cc4'], [0.24, 0.975, 54, '#f4f0f6'], [0.39, 0.99, 44, '#d978b8'], [0.61, 0.975, 52, '#e98cc4'], [0.84, 0.96, 34, '#c792d9'], [0.73, 0.92, 22, '#f2b2d6'], [0.16, 0.93, 20, '#e98cc4'], [0.5, 0.94, 18, '#f4f0f6']];
  big.forEach(([bx, by, br, bc], i) => P.cosmos(ctx, { x: W * bx, y: H * by, r: br * s, color: bc, tilt: 0.25, rot: (i % 3 - 1) * 0.3, seed: seed + 300 + i }));

  // Fireflies over the grass.
  const ff = [];
  for (let i = 0; i < 46; i++) ff.push([r() * W, H * (0.7 + r() * 0.29), r.range(0.6, 1.4)]);
  P.fireflies(ctx, ff, '#fff1a6', s);

  P.finish(ctx, W, H, { grain: 15, levels: 30, vignette: 0.25, seed: seed + 10 });
}
if (typeof module !== 'undefined' && module.exports) module.exports = scene;
