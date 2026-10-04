// A hardened Three.js scene boot plus a seeded isometric diorama generator. Copy it into a project next to a
// vendored three build; nothing here fetches anything. The data layer (generateTerrain) needs no WebGL and is
// deterministic: the same seed and options give the same world, so a "plot" can be a stable, linkable place.
//
// What to change per subject: the palette, the plot meanings (each plot is one real destination), the decor
// (trees are one motif; swap in whatever the subject's world is made of). Do not ship the defaults unchanged.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function hashSeed(text) { let h = 2166136261; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
export function mulberry32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
/** Smooth value noise in [0, 1]. */
export function noise2D(seed) {
	const lattice = (ix, iy) => { let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ seed; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
	const smooth = (t) => t * t * (3 - 2 * t);
	return (x, y) => {
		const x0 = Math.floor(x), y0 = Math.floor(y), fx = smooth(x - x0), fy = smooth(y - y0);
		const a = lattice(x0, y0), b = lattice(x0 + 1, y0), c = lattice(x0, y0 + 1), d = lattice(x0 + 1, y0 + 1);
		return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
	};
}

/** Island heightfield, biomes, evenly spread plots and decor. Pure data, no WebGL. */
export function generateTerrain({ seed = 1, size = 24, maxHeight = 5, waterLevel = 1, plots = 8, decor = 0.3 } = {}) {
	const n = noise2D(seed), rnd = mulberry32(seed ^ 0x9e3779b9), half = (size - 1) / 2;
	const heights = new Int16Array(size * size), at = (x, z) => z * size + x;
	for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
		const u = (x / size) * 3.2, v = (z / size) * 3.2;
		const ridge = n(u, v) * 0.6 + n(u * 2.1, v * 2.1) * 0.3 + n(u * 4.3, v * 4.3) * 0.1;
		const edge = Math.max(0, Math.hypot((x - half) / half, (z - half) / half) - 0.55);
		heights[at(x, z)] = x === 0 || z === 0 || x === size - 1 || z === size - 1 ? 0 : clamp(Math.round((ridge - edge * 0.9) * maxHeight * 1.1), 0, maxHeight);
	}
	const biome = (h) => (h <= waterLevel ? "water" : h === waterLevel + 1 ? "sand" : h >= maxHeight ? "rock" : "grass");
	// Plots are the places that carry meaning. Greedy farthest-point choice keeps them apart and off the water.
	const land = [];
	for (let z = 2; z < size - 2; z++) for (let x = 2; x < size - 2; x++) if (heights[at(x, z)] > waterLevel && heights[at(x, z)] < maxHeight) land.push({ x, z });
	const chosen = [];
	while (chosen.length < plots && land.length) {
		let best = -1, bestD = -1;
		const sample = chosen.length ? land : [land[Math.floor(rnd() * land.length)]];
		for (let i = 0; i < sample.length; i++) {
			const c = sample[i], d = chosen.length ? Math.min(...chosen.map((p) => Math.hypot(p.x - c.x, p.z - c.z))) : 1;
			if (d > bestD) { bestD = d; best = chosen.length ? i : land.indexOf(sample[0]); }
		}
		const p = land.splice(best, 1)[0];
		if (chosen.length && bestD < 2.5) break;
		chosen.push(p);
	}
	const plotList = chosen.map((p, i) => {
		const h = Math.max(waterLevel + 1, heights[at(p.x, p.z)]);
		for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const k = at(p.x + dx, p.z + dz); if (heights[k] > waterLevel) heights[k] = h; }
		return { id: i, x: p.x, z: p.z, h };
	});
	const taken = new Set(plotList.flatMap((p) => { const out = []; for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) out.push(at(p.x + dx, p.z + dz)); return out; }));
	const trees = [];
	for (let z = 1; z < size - 1; z++) for (let x = 1; x < size - 1; x++) {
		const k = at(x, z);
		if (!taken.has(k) && biome(heights[k]) === "grass" && rnd() < decor) trees.push({ x, z, h: heights[k], scale: 1.0 + rnd() * 0.7 });
	}
	const columns = Array.from(heights, (h, i) => ({ x: i % size, z: Math.floor(i / size), h, biome: biome(h) }));
	return { seed, size, maxHeight, waterLevel, heights, columns, plots: plotList, trees, signature: hashSeed(Array.from(heights).join(",") + "|" + plotList.map((p) => `${p.x}.${p.z}`).join(";")) };
}

const PALETTE = { sky: "#cfe6f7", water: "#4aa3c8", sand: "#e7d9a6", grass: "#6fae4f", rock: "#8c8f96", trunk: "#7a5a3a", leaf: "#3f8a45", cloud: "#ffffff", plots: ["#e8654a", "#f2b632", "#3f7fd9", "#c25ad0", "#2fb59a", "#e07a30"] };

/** Orthographic three-quarter camera that frames a square world; call again (or setFrame) on resize. */
export function makeIsoCamera(THREE, size, aspect = 1) {
	const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
	const d = size * 1.4;
	camera.position.set(d, d * 0.82, d);
	camera.lookAt(size / 2, 1.2, size / 2);
	// offset shifts the world sideways as a fraction of the half-width (0.3 pushes it right, leaving a text column on the left).
	camera.userData.setFrame = (a, zoom = 1, offset = 0) => { const s = (size * 0.78) / zoom, shift = -offset * s * a; camera.left = -s * a + shift; camera.right = s * a + shift; camera.top = s; camera.bottom = -s; camera.updateProjectionMatrix(); };
	camera.userData.setFrame(aspect);
	return camera;
}

/** Build the three.js objects for a terrain: instanced columns, trees, plots, water and clouds. */
export function createDiorama({ THREE, terrain, palette = PALETTE }) {
	const P = { ...PALETTE, ...palette }, group = new THREE.Group();
	const { size, columns, trees, plots, waterLevel } = terrain, color = new THREE.Color();
	const column = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), columns.length);
	const dummy = new THREE.Object3D(), heightAt = (x, z) => (x < 0 || z < 0 || x >= size || z >= size ? 0 : terrain.heights[z * size + x]);
	columns.forEach((c, i) => {
		const top = c.biome === "water" ? waterLevel - 0.4 : c.h;
		dummy.position.set(c.x + 0.5, top / 2, c.z + 0.5);
		dummy.scale.set(1, Math.max(0.2, top), 1);
		dummy.updateMatrix(); column.setMatrixAt(i, dummy.matrix);
		// Cheap ambient occlusion: a column darkens for each taller neighbour, so steps read without shadow maps.
		const shade = 1 - 0.07 * [heightAt(c.x + 1, c.z), heightAt(c.x - 1, c.z), heightAt(c.x, c.z + 1), heightAt(c.x, c.z - 1)].filter((h) => h > c.h).length;
		column.setColorAt(i, color.set(P[c.biome]).multiplyScalar(shade * (0.96 + ((c.x * 7 + c.z * 13) % 5) * 0.01)));
	});
	column.instanceMatrix.needsUpdate = true; column.instanceColor.needsUpdate = true;
	group.add(column);

	const trunk = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 0.6, 0.22), new THREE.MeshLambertMaterial({ color: P.trunk }), Math.max(1, trees.length));
	const crown = new THREE.InstancedMesh(new THREE.ConeGeometry(0.55, 1.25, 5), new THREE.MeshLambertMaterial({ color: P.leaf }), Math.max(1, trees.length));
	trunk.count = crown.count = trees.length;
	const placeTrees = (t) => trees.forEach((tree, i) => {
		const sway = Math.sin(t * 1.3 + tree.x * 0.9 + tree.z * 0.6) * 0.045;
		dummy.position.set(tree.x + 0.5, tree.h + 0.3 * tree.scale, tree.z + 0.5); dummy.rotation.set(sway, 0, sway); dummy.scale.setScalar(tree.scale); dummy.updateMatrix(); trunk.setMatrixAt(i, dummy.matrix);
		dummy.position.y = tree.h + 1.05 * tree.scale; dummy.updateMatrix(); crown.setMatrixAt(i, dummy.matrix);
	});
	placeTrees(0); trunk.instanceMatrix.needsUpdate = crown.instanceMatrix.needsUpdate = true;
	group.add(trunk, crown);

	// Each plot is one destination: a pad (the pickable surface) and a small roofed marker.
	const pads = plots.map((p) => {
		const fill = new THREE.Color(P.plots[p.id % P.plots.length]);
		const pad = new THREE.Mesh(new THREE.BoxGeometry(3.1, 0.16, 3.1), new THREE.MeshLambertMaterial({ color: fill }));
		pad.position.set(p.x + 0.5, p.h + 0.07, p.z + 0.5); pad.userData.plot = p;
		const hut = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.1, 1.5), new THREE.MeshLambertMaterial({ color: color.set("#ffffff").lerp(fill, 0.22).getHex() }));
		hut.position.set(0, 0.65, 0); const roof = new THREE.Mesh(new THREE.ConeGeometry(1.3, 0.85, 4), new THREE.MeshLambertMaterial({ color: fill }));
		roof.position.set(0, 1.62, 0); roof.rotation.y = Math.PI / 4; pad.add(hut, roof);
		group.add(pad); return pad;
	});

	const water = new THREE.Mesh(new THREE.BoxGeometry(size, 0.2, size), new THREE.MeshLambertMaterial({ color: P.water, transparent: true, opacity: 0.82 }));
	water.position.set(size / 2, waterLevel - 0.1, size / 2); group.add(water);

	const clouds = Array.from({ length: 5 }, (_, i) => {
		const cloud = new THREE.Group(), puffs = 3 + (i % 2);
		for (let k = 0; k < puffs; k++) { const puff = new THREE.Mesh(new THREE.BoxGeometry(1.6 + (k % 2) * 0.8, 0.6, 1.1), new THREE.MeshLambertMaterial({ color: P.cloud })); puff.position.set(k * 1.1, (k % 2) * 0.25, 0); cloud.add(puff); }
		cloud.position.set((i * 7.3) % size, 9 + (i % 3) * 0.8, (i * 4.1 + 3) % size); group.add(cloud); return cloud;
	});
	const lights = [new THREE.HemisphereLight(P.sky, P.grass, 1.05), new THREE.DirectionalLight("#ffffff", 1.15)];
	lights[1].position.set(-size * 0.4, size * 0.9, size * 0.3); group.add(...lights);

	return {
		group, plots, pads, terrain,
		/** Advance the ambient life: water breathing, trees swaying, clouds drifting. Cheap, no allocation. */
		update(t) { water.position.y = waterLevel - 0.1 + Math.sin(t * 0.8) * 0.03; placeTrees(t); trunk.instanceMatrix.needsUpdate = crown.instanceMatrix.needsUpdate = true; clouds.forEach((c, i) => { c.position.x = ((c.position.x + 0.004 * (1 + i * 0.2)) % (size + 6)); }); },
		/** The plot under a THREE.Raycaster, or null. Pair every pointer path with a real list of links for keyboards. */
		pick(raycaster) { const hit = raycaster.intersectObjects(pads, true)[0]; let o = hit?.object; while (o && !o.userData.plot) o = o.parent; return o?.userData.plot ?? null; },
		/** Emphasize one plot (hover/focus); pass null to clear. */
		highlight(id) { pads.forEach((pad) => { pad.scale.setScalar(pad.userData.plot.id === id ? 1.08 : 1); }); },
	};
}

/** Renderer lifecycle that survives real pages: adaptive resolution, pause when hidden or off screen, context loss,
 * reduced motion (one still frame, no loop), teardown. onFrame(seconds, dt) runs before each render. */
export function bootScene({ THREE, canvas, scene, camera, onFrame, onResize, pixelRatioCap = 2, antialias = true, preserveDrawingBuffer = false, reducedMotion }) {
	const renderer = new THREE.WebGLRenderer({ canvas, antialias, preserveDrawingBuffer, powerPreference: "high-performance" });
	const query = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : undefined;
	let still = reducedMotion ?? query?.matches ?? false, raf = 0, last = 0, running = false, visible = true, pixelRatio = Math.min(globalThis.devicePixelRatio || 1, pixelRatioCap), slow = 0, ema = 1 / 60, disposed = false;
	const resize = () => {
		const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
		renderer.setPixelRatio(pixelRatio); renderer.setSize(w, h, false);
		if (camera?.isPerspectiveCamera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
		onResize?.(w, h, camera);
		if (!running) renderOnce();
	};
	const renderOnce = () => { if (!disposed) { onFrame?.(last / 1000, 0); renderer.render(scene, camera); } };
	const loop = (now) => {
		raf = requestAnimationFrame(loop);
		const dt = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60); last = now;
		onFrame?.(now / 1000, dt); renderer.render(scene, camera);
		// Adaptive resolution: sustained slow frames cost pixels, not features.
		ema += (dt - ema) * 0.1; slow = ema > 1 / 40 ? slow + 1 : 0;
		if (slow > 45 && pixelRatio > 1) { pixelRatio = Math.max(1, pixelRatio - 0.25); slow = 0; resize(); }
	};
	const start = () => { if (running || still || !visible || disposed) return; running = true; last = 0; raf = requestAnimationFrame(loop); };
	const stop = () => { running = false; cancelAnimationFrame(raf); };
	const onVisibility = () => { visible = document.visibilityState !== "hidden" && visible; document.visibilityState === "hidden" ? stop() : start(); };
	const onMotion = () => { still = reducedMotion ?? query.matches; still ? (stop(), renderOnce()) : start(); };
	const onLost = (event) => { event.preventDefault(); stop(); };
	const onRestored = () => { still ? renderOnce() : start(); };
	const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : undefined;
	const intersection = typeof IntersectionObserver === "function" ? new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; visible ? start() : stop(); }) : undefined;
	resizeObserver?.observe(canvas.parentElement ?? canvas); intersection?.observe(canvas);
	document.addEventListener("visibilitychange", onVisibility); query?.addEventListener?.("change", onMotion);
	canvas.addEventListener("webglcontextlost", onLost); canvas.addEventListener("webglcontextrestored", onRestored);
	resize();
	return {
		renderer, start, stop, renderOnce, resize,
		get running() { return running; }, get pixelRatio() { return pixelRatio; },
		/** Stop everything and free GPU memory. Only call with a scene this page built; shared assets stay the owner's job. */
		dispose({ scene: disposeScene = false } = {}) {
			disposed = true; stop(); resizeObserver?.disconnect(); intersection?.disconnect();
			document.removeEventListener("visibilitychange", onVisibility); query?.removeEventListener?.("change", onMotion);
			canvas.removeEventListener("webglcontextlost", onLost); canvas.removeEventListener("webglcontextrestored", onRestored);
			if (disposeScene) scene.traverse((o) => { o.geometry?.dispose(); for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) m.dispose(); });
			renderer.dispose();
		},
	};
}
