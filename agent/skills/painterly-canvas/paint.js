/*
 * painterly-canvas: a brush kit for painted illustrations on a 2D canvas.
 * No dependencies. Works in a browser page (window.Paint) and with any
 * canvas that has the standard 2D context. Every function takes a seed, so a
 * picture comes out the same each time.
 *
 * Layers, back to front: sky, stars, moon, clouds, haze, ridge, sea, town,
 * poles and wires, meadow, plumes, flowers, fireflies, then the finish
 * (grain + dither + vignette) over everything.
 */
(function (root) {
  'use strict';
  const P = {};
  const TAU = Math.PI * 2;
  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
  P.clamp = clamp; P.smooth = smooth;

  /* ---------- randomness ---------- */
  P.rng = function (seed) {
    let a = (seed >>> 0) || 1;
    const r = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    r.range = (lo, hi) => lo + (hi - lo) * r();
    r.int = (lo, hi) => Math.floor(lo + (hi - lo + 1) * r());
    r.pick = (arr) => arr[Math.floor(r() * arr.length)];
    r.gauss = () => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * r()); };
    r.chance = (p) => r() < p;
    return r;
  };

  /** Smooth value noise in [0,1]; n.fbm(x, y, octaves) layers it. */
  P.noise = function (seed) {
    const r = P.rng(seed), perm = new Uint16Array(512), val = new Float32Array(256);
    for (let i = 0; i < 256; i++) { perm[i] = i; val[i] = r(); }
    for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
    for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
    const v = (x, y) => val[perm[(x & 255) + perm[y & 255]]];
    const n = (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
      const u = xf * xf * (3 - 2 * xf), w = yf * yf * (3 - 2 * yf);
      const a = v(xi, yi), b = v(xi + 1, yi), c = v(xi, yi + 1), d = v(xi + 1, yi + 1);
      return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
    };
    n.fbm = (x, y, oct = 4) => { let s = 0, amp = 0.5, f = 1, norm = 0; for (let i = 0; i < oct; i++) { s += amp * n(x * f, y * f); norm += amp; amp *= 0.5; f *= 2.03; } return s / norm; };
    return n;
  };

  /* ---------- colour ---------- */
  P.hex = (h) => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map((c) => c + c).join(''); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  P.mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  P.css = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
  P.jitter = (c, r, amt) => [c[0] + (r() - 0.5) * 2 * amt, c[1] + (r() - 0.5) * 2 * amt, c[2] + (r() - 0.5) * 2 * amt];
  P.light = (c, k) => (k >= 0 ? P.mix(c, [255, 255, 255], k) : P.mix(c, [0, 0, 0], -k));
  /** A colour ramp: stops [[0,'#hex'],…,[1,'#hex']] -> t => [r,g,b]. */
  P.ramp = (stops) => {
    const s = stops.map(([t, c]) => [t, typeof c === 'string' ? P.hex(c) : c]);
    return (t) => {
      t = clamp(t);
      for (let i = 1; i < s.length; i++) if (t <= s[i][0]) { const [t0, c0] = s[i - 1], [t1, c1] = s[i]; return P.mix(c0, c1, (t - t0) / ((t1 - t0) || 1)); }
      return s[s.length - 1][1].slice();
    };
  };

  /* ---------- surfaces ---------- */
  P.layer = (w, h) => {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  };

  /* ---------- brushes ---------- */
  /** A palette-knife dab: a rough, corner-cut block. The basic mark of the style. */
  P.dab = (ctx, x, y, w, h, ang, color, alpha, r) => {
    const cos = Math.cos(ang), sin = Math.sin(ang), hw = w / 2, hh = h / 2;
    const pts = [[-1, -0.7], [-0.6, -1], [0.7, -1], [1, -0.55], [1, 0.6], [0.6, 1], [-0.7, 1], [-1, 0.5]];
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const jx = pts[i][0] * hw * (1 + (r() - 0.5) * 0.4), jy = pts[i][1] * hh * (1 + (r() - 0.5) * 0.4);
      const X = x + jx * cos - jy * sin, Y = y + jx * sin + jy * cos;
      if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
    }
    ctx.closePath();
    ctx.fillStyle = P.css(color, alpha);
    ctx.fill();
  };

  /** A tapered curved stroke (grass blade, stem, hair): quadratic from p0 through c to p1, width w at the base. */
  P.blade = (ctx, x0, y0, cx, cy, x1, y1, w, color, alpha, tipW = 0.15) => {
    const N = 9, L = [], R = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N, m = 1 - t;
      const x = m * m * x0 + 2 * m * t * cx + t * t * x1, y = m * m * y0 + 2 * m * t * cy + t * t * y1;
      const dx = 2 * m * (cx - x0) + 2 * t * (x1 - cx), dy = 2 * m * (cy - y0) + 2 * t * (y1 - cy), l = Math.hypot(dx, dy) || 1;
      const hw = (w * (1 - t) + tipW) / 2;
      L.push([x - (dy / l) * hw, y + (dx / l) * hw]); R.push([x + (dy / l) * hw, y - (dx / l) * hw]);
    }
    ctx.beginPath(); ctx.moveTo(L[0][0], L[0][1]);
    for (let i = 1; i < L.length; i++) ctx.lineTo(L[i][0], L[i][1]);
    for (let i = R.length - 1; i >= 0; i--) ctx.lineTo(R[i][0], R[i][1]);
    ctx.closePath(); ctx.fillStyle = P.css(color, alpha); ctx.fill();
  };
  /** Point and tangent on a quadratic curve. */
  P.quad = (x0, y0, cx, cy, x1, y1, t) => {
    const m = 1 - t;
    return { x: m * m * x0 + 2 * m * t * cx + t * t * x1, y: m * m * y0 + 2 * m * t * cy + t * t * y1,
      dx: 2 * m * (cx - x0) + 2 * t * (x1 - cx), dy: 2 * m * (cy - y0) + 2 * t * (y1 - cy) };
  };

  /** Soft light: a radial falloff, added with 'lighter' unless told otherwise. */
  P.glow = (ctx, x, y, rad, color, alpha, mode = 'lighter') => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, P.css(color, alpha)); g.addColorStop(0.35, P.css(color, alpha * 0.35)); g.addColorStop(1, P.css(color, 0));
    const prev = ctx.globalCompositeOperation; ctx.globalCompositeOperation = mode;
    ctx.fillStyle = g; ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    ctx.globalCompositeOperation = prev;
  };

  /* ---------- sky ---------- */
  /**
   * Gradient sky covered in short horizontal knife dabs, so it reads painted, not airbrushed.
   * o: { bottom (px), ramp (t=0 top … 1 at bottom), seed, scale, density }
   */
  P.sky = (ctx, W, o) => {
    const s = o.scale ?? W / 1080, r = P.rng(o.seed ?? 1), n = P.noise((o.seed ?? 1) + 11), B = o.bottom;
    const g = ctx.createLinearGradient(0, 0, 0, B);
    for (let i = 0; i <= 16; i++) g.addColorStop(i / 16, P.css(o.ramp(i / 16)));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, B);
    const count = Math.round((W * B) / (70 * s * s) * (o.density ?? 1));
    for (let i = 0; i < count; i++) {
      const x = r() * W, y = r() * B;
      const t = y / B + (n.fbm(x / (260 * s), y / (130 * s)) - 0.5) * 0.16 + (r() - 0.5) * 0.035;
      P.dab(ctx, x, y, r.range(5, 16) * s, r.range(2, 6) * s, r.range(-0.25, 0.25), P.jitter(o.ramp(t), r, 7), r.range(0.25, 0.65), r);
    }
  };

  /** Four-point sparkle with a soft core. */
  P.sparkle = (ctx, x, y, size, color) => {
    P.glow(ctx, x, y, size * 1.6, color, 0.35);
    const w = size * 0.13;
    ctx.beginPath();
    ctx.moveTo(x, y - size); ctx.lineTo(x + w, y - w); ctx.lineTo(x + size * 0.75, y); ctx.lineTo(x + w, y + w);
    ctx.lineTo(x, y + size); ctx.lineTo(x - w, y + w); ctx.lineTo(x - size * 0.75, y); ctx.lineTo(x - w, y - w);
    ctx.closePath(); ctx.fillStyle = P.css(color, 0.95); ctx.fill();
  };
  /** Star field: many specks fading toward the horizon, a few sparkles. o: { top, bottom, count, sparkles, seed, scale, color } */
  P.stars = (ctx, W, o) => {
    const s = o.scale ?? W / 1080, r = P.rng(o.seed ?? 5), col = o.color ? P.hex(o.color) : [255, 246, 228];
    const top = o.top ?? 0, bottom = o.bottom;
    for (let i = 0; i < (o.count ?? 420); i++) {
      const y = top + Math.pow(r(), 1.6) * (bottom - top), x = r() * W, fade = 1 - (y - top) / (bottom - top);
      const rad = r.range(0.6, 1.9) * s * (r.chance(0.06) ? 1.6 : 1);
      ctx.fillStyle = P.css(col, clamp(r.range(0.35, 1) * fade + 0.1)); ctx.beginPath(); ctx.arc(x, y, rad, 0, TAU); ctx.fill();
    }
    for (const sp of o.sparkles ?? []) P.sparkle(ctx, sp[0], sp[1], sp[2] * s, col);
  };

  /** Crescent moon with halo and a faint earthshine disc. o: { phase 0..1 (how thin), tilt, color, sky } */
  P.moon = (ctx, x, y, R, o = {}) => {
    const col = P.hex(o.color ?? '#fff1c9');
    P.glow(ctx, x, y, R * 3.2, [170, 160, 230], 0.22, 'screen');
    P.glow(ctx, x, y, R * 1.7, col, 0.18, 'screen');
    ctx.fillStyle = P.css(P.hex(o.disc ?? '#4b4f9e'), 0.55); ctx.beginPath(); ctx.arc(x, y, R * 0.98, 0, TAU); ctx.fill();
    const c = P.layer(Math.ceil(R * 3), Math.ceil(R * 3)), k = c.getContext('2d'), m = R * 1.5;
    k.fillStyle = P.css(col); k.beginPath(); k.arc(m, m, R, 0, TAU); k.fill();
    k.globalCompositeOperation = 'destination-out';
    const tilt = o.tilt ?? -0.6, off = R * (0.35 + 0.4 * (o.phase ?? 0.5));
    k.beginPath(); k.arc(m + Math.cos(tilt) * off, m + Math.sin(tilt) * off, R * 0.97, 0, TAU); k.fill();
    ctx.drawImage(c, x - m, y - m);
  };

  /* ---------- clouds ---------- */
  /**
   * A cumulus built from bubbles that grow upward inside a tower profile, then painted dab by dab
   * from a sphere-lighting model: lit side through the warm end of the ramp, shade through the cool end.
   * o: { x (centre), base (y of the flat bottom), width, height, towers: [{at 0..1, h 0..1, w 0..1}],
   *      ramp (0 shade … 1 lit), light [x,y,z], seed, scale, bubbles, ao (0..1 darkening at the base),
   *      tint: (x, y) => [color, amount] optional cool/warm shift }
   */
  P.cumulus = (ctx, o) => {
    const s = o.scale ?? 1, r = P.rng(o.seed ?? 3), n = P.noise((o.seed ?? 3) + 5);
    let [lx, ly, lz] = o.light ?? [-0.7, -0.3, 0.65]; const ll = Math.hypot(lx, ly, lz); lx /= ll; ly /= ll; lz /= ll;
    const left = o.x - o.width / 2, towers = o.towers ?? [{ at: 0.5, h: 1, w: 0.7 }];
    const prof = (u) => { let h = 0.1; for (const t of towers) { const d = (u - t.at) / (t.w / 2); if (Math.abs(d) < 1) h = Math.max(h, t.h * Math.pow(1 - d * d, 0.55)); } return h; };
    // Bubbles fill the tower profile: big and dense low down, smaller toward the crowns, and the top of
    // every bubble kept inside the profile so the outline follows the towers.
    const R0 = o.width * (o.baseSize ?? 0.075), lumps = [], want = o.bubbles ?? 220;
    for (let i = 0; i < want; i++) {
      const u = 0.03 + 0.94 * r(), top = prof(u) * o.height, x = left + u * o.width;
      const v = Math.pow(r(), 0.7), hgt = v * top;
      let rad = R0 * r.range(0.55, 1.15) * (0.55 + 0.6 * (1 - hgt / o.height)) * (0.6 + 0.4 * Math.sqrt(prof(u)));
      let y = o.base - hgt;
      if (o.base - (y - rad) > top) y = o.base - top + rad;
      if (y + rad * 0.45 > o.base) y = o.base - rad * 0.45;
      lumps.push({ x, y, r: rad });
    }
    // Bottom first: upper bubbles overlap lower ones, which leaves the shaded seams between lobes.
    lumps.sort((a, b) => (b.y + b.r * 0.3) - (a.y + a.r * 0.3) || a.r - b.r);
    const aoK = o.ao ?? 0.35, G = o.global ?? 0.5;
    // One shadow-toned silhouette under everything: no sky shows through gaps between bubbles.
    ctx.fillStyle = P.css(o.ramp(o.under ?? 0.4));
    for (const L of lumps) { ctx.beginPath(); ctx.arc(L.x, L.y, L.r * 0.95, 0, TAU); ctx.fill(); }
    ctx.beginPath(); ctx.moveTo(left + o.width * 0.04, o.base);
    for (let u = 0.04; u <= 0.961; u += 0.01) ctx.lineTo(left + u * o.width, o.base - prof(u) * o.height * 0.78);
    ctx.lineTo(left + o.width * 0.96, o.base); ctx.closePath(); ctx.fill();
    for (const L of lumps) {
      const ds = Math.max(3 * s, L.r * 0.2);
      const shadeAt = (px, py) => {
        const nx = (px - L.x) / L.r, ny = (py - L.y) / L.r, nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
        // Blend the bubble's own normal with the whole cloud's, so light falls in broad planes, not ball by ball.
        let gx = clamp((px - o.x) / (o.width * 0.5), -1, 1), gy = clamp((py - (o.base - o.height * 0.55)) / (o.height * 0.55), -1, 1);
        const gz = Math.sqrt(Math.max(0.05, 1 - 0.55 * (gx * gx + gy * gy))), gl = Math.hypot(gx, gy, gz); gx /= gl; gy /= gl;
        const lam = Math.max(0, (nx * lx + ny * ly + nz * lz) * (1 - G) + (gx * lx + gy * ly + (gz / gl) * lz) * G);
        const hgt = clamp((o.base - py) / o.height);
        let sh = 0.2 + lam * 0.72 + hgt * 0.16 - aoK * (1 - smooth(0, 0.3, hgt));
        sh += (n.fbm(px / (120 * s), py / (120 * s)) - 0.5) * 0.2;
        return Math.max(o.floor ?? 0.1, sh);
      };
      // under-fill so no sky shows through the bubble
      const steps = 18; ctx.beginPath();
      for (let i = 0; i <= steps; i++) { const a = (i / steps) * TAU, rr = L.r * (0.93 + 0.08 * n(L.x * 0.05 + Math.cos(a) * 2, L.y * 0.05 + Math.sin(a) * 2)); const X = L.x + Math.cos(a) * rr, Y = L.y + Math.sin(a) * rr; i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); }
      ctx.fillStyle = P.css(o.ramp(shadeAt(L.x + lx * L.r * 0.1, L.y + L.r * 0.2) - 0.08)); ctx.fill();
      const count = Math.round(((L.r * L.r) / (ds * ds)) * 3.2);
      for (let i = 0; i < count; i++) {
        const a = r() * TAU, rr = Math.sqrt(r()) * L.r * 1.02, px = L.x + Math.cos(a) * rr, py = L.y + Math.sin(a) * rr;
        let c = o.ramp(shadeAt(px, py) + (r() - 0.5) * 0.06);
        if (o.tint) { const [tc, amt] = o.tint(px, py); if (amt > 0) c = P.mix(c, P.hex(tc), amt); }
        const tang = Math.atan2(py - L.y, px - L.x) + Math.PI / 2;
        const ang = r.chance(0.6) ? tang + r.range(-0.4, 0.4) : (o.strokeAngle ?? -0.5) + r.range(-0.3, 0.3);
        P.dab(ctx, px, py, ds * r.range(0.7, 1.5), ds * r.range(0.4, 0.8), ang, P.jitter(c, r, 5), r.range(0.55, 0.95), r);
      }
    }
    return lumps;
  };

  /** A horizontal band of soft colour (horizon haze, sunset glow). */
  P.band = (ctx, W, y, h, color, alpha) => {
    const g = ctx.createLinearGradient(0, y - h / 2, 0, y + h / 2), c = P.hex(color);
    g.addColorStop(0, P.css(c, 0)); g.addColorStop(0.5, P.css(c, alpha)); g.addColorStop(1, P.css(c, 0));
    ctx.fillStyle = g; ctx.fillRect(0, y - h / 2, W, h);
  };

  /** A distant ridge silhouette from x0 to x1, resting on y. */
  P.ridge = (ctx, x0, x1, y, amp, color, seed, alpha = 1) => {
    const n = P.noise(seed), c = P.hex(color);
    ctx.beginPath(); ctx.moveTo(x0, y);
    for (let x = x0; x <= x1; x += 4) { const u = (x - x0) / (x1 - x0), fall = Math.sin(Math.PI * Math.min(1, u * 1.2)); ctx.lineTo(x, y - amp * fall * (0.55 + 0.45 * n.fbm(x / 140, 0.5, 3))); }
    ctx.lineTo(x1, y); ctx.closePath(); ctx.fillStyle = P.css(c, alpha); ctx.fill();
  };

  /** Sea: gradient plus long horizontal dabs; glints are short bright dashes. o: { top, bottom, ramp, seed, scale, glints } */
  P.sea = (ctx, W, o) => {
    const s = o.scale ?? W / 1080, r = P.rng(o.seed ?? 21), H = o.bottom - o.top;
    const g = ctx.createLinearGradient(0, o.top, 0, o.bottom);
    for (let i = 0; i <= 8; i++) g.addColorStop(i / 8, P.css(o.ramp(i / 8)));
    ctx.fillStyle = g; ctx.fillRect(0, o.top, W, H);
    const count = Math.round((W * H) / (40 * s * s));
    for (let i = 0; i < count; i++) {
      const y = o.top + r() * H, t = (y - o.top) / H;
      P.dab(ctx, r() * W, y, r.range(10, 46) * s * (1 - t * 0.4), r.range(1.2, 3.2) * s, r.range(-0.03, 0.03), P.jitter(o.ramp(t + (r() - 0.5) * 0.08), r, 6), r.range(0.3, 0.7), r);
    }
    for (const gl of o.glints ?? []) {
      for (let i = 0; i < gl.n; i++) {
        const y = gl.y + r() * gl.h, x = gl.x + r.gauss() * gl.w * (0.4 + (y - gl.y) / gl.h);
        P.dab(ctx, x, y, r.range(4, 14) * s, r.range(1, 2) * s, 0, P.hex(gl.color), r.range(0.4, 0.9), r);
      }
    }
  };

  /** A far town: a slope of small roofs and walls with warm windows. o: { x0, x1, yTop(x), yBottom, ramp, seed, scale, lights } */
  P.town = (ctx, o) => {
    const s = o.scale ?? 1, r = P.rng(o.seed ?? 31), warm = [P.hex('#ffd27a'), P.hex('#ffb35c'), P.hex('#fff0b0')];
    ctx.beginPath(); ctx.moveTo(o.x0, o.yBottom);
    for (let x = o.x0; x <= o.x1; x += 8) ctx.lineTo(x, o.yTop(x) + 3 * s);
    ctx.lineTo(o.x1, o.yBottom); ctx.closePath(); ctx.fillStyle = P.css(o.ramp(0.55)); ctx.fill();
    const rows = Math.ceil((o.yBottom - Math.min(o.yTop(o.x0), o.yTop(o.x1))) / (5 * s));
    for (let row = 0; row < rows; row++) {
      for (let x = o.x0; x < o.x1; x += r.range(5, 13) * s) {
        const top = o.yTop(x), y = top + row * 5 * s + r.range(-2, 2) * s;
        if (y > o.yBottom || y < top) continue;
        const d = (y - top) / Math.max(1, o.yBottom - top);
        P.dab(ctx, x, y, r.range(6, 16) * s * (0.7 + d * 0.6), r.range(3, 7) * s, r.range(-0.08, 0.08), P.jitter(o.ramp(d + r.range(-0.12, 0.12)), r, 8), 0.95, r);
      }
    }
    for (let i = 0; i < (o.lights ?? 160); i++) {
      const x = r.range(o.x0, o.x1), top = o.yTop(x), y = r.range(top, o.yBottom), c = r.pick(warm);
      ctx.fillStyle = P.css(c, r.range(0.55, 1)); ctx.fillRect(x, y, r.range(1.2, 2.6) * s, r.range(1.2, 2.2) * s);
      if (r.chance(0.18)) P.glow(ctx, x, y, r.range(5, 11) * s, c, 0.25);
    }
  };

  /* ---------- poles and wires ---------- */
  P.pole = (ctx, x, yTop, yBottom, w, color, o = {}) => {
    const c = P.hex(color);
    ctx.fillStyle = P.css(c);
    ctx.beginPath(); ctx.moveTo(x - w * 0.35, yTop); ctx.lineTo(x + w * 0.35, yTop); ctx.lineTo(x + w * 0.5, yBottom); ctx.lineTo(x - w * 0.5, yBottom); ctx.closePath(); ctx.fill();
    const arm = o.arm ?? w * 9;
    for (const [dy, len] of [[w * 1.2, arm], [w * 4.2, arm * 0.8]]) ctx.fillRect(x - len / 2, yTop + dy, len, w * 0.55);
    for (const dx of [-0.42, -0.2, 0.2, 0.42]) ctx.fillRect(x + dx * arm - w * 0.2, yTop + w * 0.3, w * 0.4, w * 0.9);
    return { left: [x - arm * 0.42, yTop + w * 0.4], right: [x + arm * 0.42, yTop + w * 0.4], l2: [x - arm * 0.2, yTop + w * 0.4], r2: [x + arm * 0.2, yTop + w * 0.4] };
  };
  /** A sagging wire from a to b; returns a function t -> point on it (for birds). */
  P.wire = (ctx, a, b, sag, width, color, alpha = 0.95) => {
    const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2 + sag;
    ctx.strokeStyle = P.css(P.hex(color), alpha); ctx.lineWidth = width; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.quadraticCurveTo(cx, cy, b[0], b[1]); ctx.stroke();
    return (t) => P.quad(a[0], a[1], cx, cy, b[0], b[1], t);
  };
  P.bird = (ctx, x, y, size, color) => {
    const c = P.css(P.hex(color));
    ctx.fillStyle = c; ctx.beginPath(); ctx.ellipse(x, y - size * 0.55, size * 0.42, size * 0.6, 0.2, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(x - size * 0.15, y - size * 1.2, size * 0.3, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x + size * 0.2, y - size * 0.3); ctx.lineTo(x + size * 0.75, y + size * 0.15); ctx.lineTo(x + size * 0.1, y); ctx.fill();
  };

  /* ---------- vegetation ---------- */
  /**
   * Grass field from yTop to yBottom: a dark base, then rows of blades that grow taller toward the viewer.
   * o: { top(x) -> y, bottom, ramp (0 deep … 1 lit tip), seed, scale, density, tipLight [color, amount] }
   */
  P.meadow = (ctx, W, o) => {
    const s = o.scale ?? W / 1080, r = P.rng(o.seed ?? 41), n = P.noise((o.seed ?? 41) + 2);
    ctx.beginPath(); ctx.moveTo(0, o.bottom);
    for (let x = 0; x <= W; x += 6) ctx.lineTo(x, o.top(x) + 6 * s);
    ctx.lineTo(W, o.bottom); ctx.closePath();
    const g = ctx.createLinearGradient(0, Math.min(o.top(0), o.top(W)), 0, o.bottom);
    g.addColorStop(0, P.css(o.ramp(0.35))); g.addColorStop(1, P.css(o.ramp(0)));
    ctx.fillStyle = g; ctx.fill();
    o.blades && o.blades(ctx);
    const rows = o.rows ?? 70, tip = o.tipLight ? P.hex(o.tipLight[0]) : null;
    for (let row = 0; row < rows; row++) {
      const d = row / (rows - 1);
      const per = Math.round((W / (5 * s)) * (o.density ?? 1) * (0.5 + d * 0.6));
      for (let i = 0; i < per; i++) {
        const x = r() * W, top = o.top(x), y = top + 4 * s + Math.pow(d, 1.25) * (o.bottom - top) + r.range(-6, 6) * s;
        const h = (14 + 220 * Math.pow(d, 1.6)) * s * r.range(0.55, 1.25), lean = (n(x / (300 * s), d * 3) - 0.5) * h * 1.2 + (o.wind ?? 0.15) * h;
        const shade = 0.15 + 0.45 * (1 - d) + r.range(-0.12, 0.25);
        let c = o.ramp(shade);
        P.blade(ctx, x, y, x + lean * 0.25, y - h * 0.6, x + lean, y - h, (1.2 + 4.5 * d) * s * r.range(0.6, 1.2), P.jitter(c, r, 6), r.range(0.75, 1));
        if (tip && r.chance(0.35)) { const p = P.quad(x, y, x + lean * 0.25, y - h * 0.6, x + lean, y - h, 0.8); P.blade(ctx, p.x, p.y, (p.x + x + lean) / 2, (p.y + y - h) / 2, x + lean, y - h, (0.8 + 2 * d) * s, P.mix(c, tip, o.tipLight[1]), 0.8); }
      }
    }
  };

  /**
   * Pampas grass: a bending stem with a feathery plume of fine strands on its upper part.
   * o: { x, y (base), height, lean (px the tip moves sideways), color, shade, seed, scale, strands, droop }
   */
  P.plume = (ctx, o) => {
    const s = o.scale ?? 1, r = P.rng(o.seed ?? 51);
    const x0 = o.x, y0 = o.y, x1 = o.x + o.lean, y1 = o.y - o.height, cx = o.x + o.lean * 0.15, cy = o.y - o.height * 0.55;
    const lit = P.hex(o.color ?? '#f6e3c8'), dark = P.hex(o.shade ?? '#9c8ea6'), stem = P.hex(o.stem ?? '#3a4a52');
    P.blade(ctx, x0, y0, cx, cy, x1, y1, 3.2 * s, stem, 0.9, 0.6 * s);
    for (let k = 0; k < 3; k++) { const t = r.range(0.15, 0.5), p = P.quad(x0, y0, cx, cy, x1, y1, t), side = r.chance(0.5) ? 1 : -1, len = o.height * r.range(0.25, 0.45);
      P.blade(ctx, p.x, p.y, p.x + side * len * 0.4, p.y - len * 0.6, p.x + side * len * 0.9, p.y - len * 0.3, 3 * s, P.mix(stem, [70, 96, 96], 0.4), 0.85); }
    const strands = o.strands ?? 140, droop = o.droop ?? 0.6, start = o.start ?? 0.55;
    for (let i = 0; i < strands; i++) {
      const t = start + (1 - start) * Math.pow(r(), 0.8), p = P.quad(x0, y0, cx, cy, x1, y1, t), l = Math.hypot(p.dx, p.dy) || 1;
      const tx = p.dx / l, ty = p.dy / l, side = r.chance(0.5) ? 1 : -1;
      const spread = r.range(0.15, 0.75) * side;
      let ax = tx * Math.cos(spread) - ty * Math.sin(spread), ay = tx * Math.sin(spread) + ty * Math.cos(spread);
      const len = o.height * r.range(0.09, 0.22) * (o.fluff ?? 1) * (1.15 - (t - start) / (1 - start) * 0.5);
      const ex = p.x + ax * len + (o.lean > 0 ? 1 : -1) * len * 0.25, ey = p.y + ay * len + len * droop * 0.45;
      const litSide = (ax * -0.7 + ay * -0.3) > 0 ? 1 : 0.35;
      const c = P.jitter(P.mix(dark, lit, clamp(litSide * r.range(0.55, 1.05))), r, 10);
      P.blade(ctx, p.x, p.y, p.x + ax * len * 0.6, p.y + ay * len * 0.6, ex, ey, r.range(1.2, 3) * s, c, r.range(0.3, 0.75), 0.3 * s);
    }
  };

  /** A cosmos flower seen at an angle. o: { x, y, r, color, center, tilt (0 face-on … 0.8 side), rot, seed, petals } */
  P.cosmos = (ctx, o) => {
    const r = P.rng(o.seed ?? 61), petals = o.petals ?? 8, col = P.hex(o.color ?? '#e58bc3'), tilt = 1 - (o.tilt ?? 0.3);
    ctx.save(); ctx.translate(o.x, o.y); ctx.rotate(o.rot ?? 0); ctx.scale(1, tilt);
    for (let i = 0; i < petals; i++) {
      const a = (i / petals) * TAU + r.range(-0.12, 0.12), R = o.r * r.range(0.85, 1.08), w = o.r * 0.42;
      ctx.save(); ctx.rotate(a);
      ctx.beginPath(); ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(w * 0.9, R * 0.35, w * 0.55, R * 0.95);
      ctx.lineTo(w * 0.25, R * 0.86); ctx.lineTo(0, R); ctx.lineTo(-w * 0.25, R * 0.88); ctx.lineTo(-w * 0.55, R * 0.95);
      ctx.quadraticCurveTo(-w * 0.9, R * 0.35, 0, 0); ctx.closePath();
      ctx.fillStyle = P.css(P.jitter(P.light(col, r.range(-0.12, 0.05)), r, 8)); ctx.fill();
      for (let k = 0; k < 3; k++) P.dab(ctx, r.range(-w, w) * 0.35, R * r.range(0.35, 0.85), w * 0.4, R * 0.12, Math.PI / 2, P.light(col, r.range(0.12, 0.35)), 0.6, r);
      ctx.restore();
    }
    const cc = P.hex(o.center ?? '#f2b13a');
    ctx.fillStyle = P.css(P.light(cc, -0.25)); ctx.beginPath(); ctx.arc(0, 0, o.r * 0.26, 0, TAU); ctx.fill();
    for (let k = 0; k < 14; k++) { const a = r() * TAU, d = Math.sqrt(r()) * o.r * 0.22; ctx.fillStyle = P.css(P.light(cc, r.range(-0.1, 0.35))); ctx.beginPath(); ctx.arc(Math.cos(a) * d, Math.sin(a) * d, o.r * 0.07, 0, TAU); ctx.fill(); }
    ctx.restore();
  };

  /** Fireflies: tiny warm cores with soft halos. */
  P.fireflies = (ctx, list, color = '#fff3a8', scale = 1) => {
    const c = P.hex(color);
    for (const [x, y, k] of list) { P.glow(ctx, x, y, 14 * k * scale, c, 0.35); ctx.fillStyle = P.css(c, 0.95); ctx.beginPath(); ctx.arc(x, y, 1.6 * k * scale, 0, TAU); ctx.fill(); }
  };

  /* ---------- finish ---------- */
  /**
   * The finish that makes it read as a painted print: clumped grain (dry-brush speckle), an ordered-dither
   * posterise, and a vignette. o: { grain 0..40, levels (per channel, 0 = off), vignette 0..1, seed }
   */
  P.finish = (ctx, W, H, o = {}) => {
    const img = ctx.getImageData(0, 0, W, H), d = img.data, r = P.rng(o.seed ?? 99), n = P.noise((o.seed ?? 99) + 1);
    const grain = o.grain ?? 16, levels = o.levels ?? 28, vig = o.vignette ?? 0.28, q = levels > 1 ? 255 / (levels - 1) : 0;
    const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    const cxm = W / 2, cym = H / 2, rmax = Math.hypot(cxm, cym);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const clump = (n(x * 0.45, y * 0.45) - 0.5) * 1.4 + (r() - 0.5);
        const v = 1 - vig * Math.pow(Math.hypot(x - cxm, y - cym) / rmax, 2.2);
        const th = q ? (bayer[(y & 3) * 4 + (x & 3)] / 16 - 0.5) * q : 0;
        for (let c = 0; c < 3; c++) {
          let val = d[i + c] * v + clump * grain;
          if (q) val = Math.round((val + th) / q) * q;
          d[i + c] = val < 0 ? 0 : val > 255 ? 255 : val;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  };

  root.Paint = P;
  if (typeof module !== 'undefined' && module.exports) module.exports = P;
})(typeof window !== 'undefined' ? window : globalThis);
