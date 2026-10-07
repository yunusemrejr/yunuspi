/** Browser recipe runtimes. Content and visual tokens belong to the host page. */
const mounts = new WeakMap();

export function mountScrollReveal(root, config) {
  mounts.get(root)?.dispose();
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const animations = new Map(), finished = new WeakSet();
  let observer, disposed = false;
  const targets = () => [...root.querySelectorAll(config.selector)].slice(0, 200);
  const settle = element => { animations.get(element)?.cancel(); animations.delete(element); finished.add(element); };
  const reveal = element => {
    if (disposed || finished.has(element) || animations.has(element)) return;
    if (preference.matches || !element.animate) { settle(element); return; }
    const animation = element.animate(config.keyframes, { duration: config.durationMs, easing: config.easing, fill: 'both' });
    animations.set(element, animation);
    animation.finished.then(() => settle(element), () => {});
  };
  const refresh = () => {
    if (disposed) return;
    observer?.disconnect();
    if (preference.matches || !globalThis.IntersectionObserver) { targets().forEach(settle); return; }
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) { reveal(entry.target); observer.unobserve(entry.target); }
    }, { threshold: 0.12, rootMargin: '0px 0px -4% 0px' });
    targets().forEach(element => { if (!finished.has(element)) observer.observe(element); });
  };
  const focus = event => { for (const element of targets()) if (element.contains(event.target)) { settle(element); observer?.unobserve(element); } };
  root.addEventListener('focusin', focus);
  preference.addEventListener('change', refresh);
  const handle = { kind: 'scroll-reveal', refresh, dispose() {
    if (disposed) return;
    disposed = true; observer?.disconnect();
    for (const animation of animations.values()) animation.cancel();
    animations.clear(); root.removeEventListener('focusin', focus); preference.removeEventListener('change', refresh);
    if (mounts.get(root) === handle) mounts.delete(root);
  } };
  mounts.set(root, handle); refresh(); return handle;
}

export function mountScrollStory(root, config) {
  mounts.get(root)?.dispose();
  const preference = matchMedia('(prefers-reduced-motion: reduce)'), narrow = matchMedia(`(max-width: ${config.mobileBelow - 1}px)`);
  const section = root.querySelector(config.section);
  if (!section) throw Error(`Scroll section missing: ${config.section}`);
  let disposed = false, raf = 0, visible = true, effects = [], observer, manualProgress = null;
  const clear = () => { for (const effect of effects) effect.animation.cancel(); effects = []; };
  const apply = progress => {
    for (const effect of effects) effect.animation.currentTime = Math.max(0, Math.min(1, (progress - effect.start) / (effect.end - effect.start))) * 1000;
  };
  const draw = () => {
    raf = 0;
    if (disposed || !visible || document.hidden || preference.matches || narrow.matches) return;
    if (manualProgress !== null) { apply(manualProgress); return; }
    const bounds = section.getBoundingClientRect(), span = bounds.height - innerHeight;
    const progress = span > 0 ? Math.max(0, Math.min(1, -bounds.top / span)) : 0;
    apply(progress);
  };
  const schedule = () => { if (!disposed && !raf) raf = requestAnimationFrame(draw); };
  const refresh = () => {
    clear();
    if (disposed || preference.matches || narrow.matches) return;
    const owners = new Set(), candidates = [];
    for (const track of config.tracks) for (const element of section.querySelectorAll(track.selector)) {
      if (candidates.length >= 200) break;
      if (owners.has(element)) throw Error('Scroll tracks resolve to the same element; merge its transforms into one track');
      owners.add(element);
      if (candidates.length < 200 && element.animate) candidates.push({ element, track });
    }
    try {
      for (const { element, track } of candidates) {
        const animation = element.animate(track.keyframes, { duration: 1000, easing: track.easing ?? 'linear', fill: 'both' });
        animation.pause(); effects.push({ animation, start: track.start, end: track.end });
      }
    } catch (error) { clear(); throw error; }
    if (manualProgress !== null) apply(manualProgress);
    else schedule();
  };
  if (globalThis.IntersectionObserver) {
    observer = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting); if (visible) schedule(); });
    observer.observe(section);
  }
  addEventListener('scroll', schedule, { passive: true }); addEventListener('resize', schedule, { passive: true });
  document.addEventListener('visibilitychange', schedule);
  preference.addEventListener('change', refresh); narrow.addEventListener('change', refresh);
  const handle = { kind: 'scroll-story', refresh,
    // The same authored tracks can use a video frame clock. Explicit seeking
    // owns progress until resume(), including after scroll/resize callbacks.
    seek(progress) {
      if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 1) throw Error('Story progress must be finite in 0..1');
      if (disposed) throw Error('Scroll story has been disposed');
      manualProgress = progress; cancelAnimationFrame(raf); raf = 0;
      if (preference.matches || narrow.matches) return false;
      apply(progress); return effects.length > 0;
    },
    resume() { if (!disposed) { manualProgress = null; schedule(); } },
    dispose() {
    if (disposed) return;
    disposed = true; cancelAnimationFrame(raf); clear(); observer?.disconnect();
    removeEventListener('scroll', schedule); removeEventListener('resize', schedule); document.removeEventListener('visibilitychange', schedule);
    preference.removeEventListener('change', refresh); narrow.removeEventListener('change', refresh);
    if (mounts.get(root) === handle) mounts.delete(root);
  } };
  mounts.set(root, handle);
  try { refresh(); } catch (error) { handle.dispose(); throw error; }
  return handle;
}

export function mountUiModel(element, config, { THREE, GLTFLoader, configureLoader }) {
  mounts.get(element)?.dispose();
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  let renderer, model, fitRadius = 1, observer, resizeObserver, disposed = false, raf = 0, visible = true, phase = 'loading';
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
  const geometries = new Set(), materials = new Set(), textures = new Set(), skeletons = new Set();
  const remember = object => object?.traverse(node => {
    if (node.geometry) geometries.add(node.geometry);
    if (node.skeleton) skeletons.add(node.skeleton);
    for (const material of Array.isArray(node.material) ? node.material : node.material ? [node.material] : []) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  const release = object => { remember(object); for (const texture of textures) { texture.source?.data?.close?.(); texture.dispose(); } for (const material of materials) material.dispose(); for (const geometry of geometries) geometry.dispose(); for (const skeleton of skeletons) skeleton.dispose(); textures.clear(); materials.clear(); geometries.clear(); skeletons.clear(); };
  const draw = () => {
    raf = 0;
    if (disposed || phase !== 'ready' || !renderer || !model || !visible || document.hidden) return;
    if (config.scrollSection && !preference.matches) {
      const section = document.querySelector(config.scrollSection), rect = section?.getBoundingClientRect();
      if (rect) { const span = rect.height - innerHeight, progress = span > 0 ? Math.max(0, Math.min(1, -rect.top / span)) : 0; model.rotation.y = config.rotationFrom + progress * (config.rotationTo - config.rotationFrom); }
    } else model.rotation.y = config.rotationFrom;
    renderer.render(scene, camera);
  };
  const schedule = () => { if (!disposed && !raf) raf = requestAnimationFrame(draw); };
  const resize = () => {
    if (disposed || !renderer) return;
    const width = Math.max(1, element.clientWidth), height = Math.max(1, element.clientHeight);
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, config.maxDpr)); renderer.setSize(width, height, false);
    camera.aspect = width / height;
    if (model) {
      const vertical = camera.fov * Math.PI / 360, horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
      const distance = fitRadius / Math.sin(Math.min(vertical, horizontal)) * 1.15;
      camera.position.set(0, 0, Math.max(0.1, distance)); camera.lookAt(0, 0, 0); camera.near = Math.max(0.001, distance / 100); camera.far = Math.max(10, distance * 100);
    }
    camera.updateProjectionMatrix(); schedule();
  };
  const fallback = reason => { phase = reason; element.dataset.uiModelState = reason; if (renderer?.domElement) renderer.domElement.hidden = true; };
  const lost = event => { event.preventDefault(); fallback('context-lost'); handle.dispose(); };
  const handle = { kind: 'three-model', get status() { return phase; }, refresh: resize, dispose() {
    if (disposed) return;
    disposed = true; cancelAnimationFrame(raf); observer?.disconnect(); resizeObserver?.disconnect();
    removeEventListener('scroll', schedule); removeEventListener('resize', resize); document.removeEventListener('visibilitychange', schedule); preference.removeEventListener('change', schedule);
    if (renderer) { renderer.domElement.removeEventListener('webglcontextlost', lost); renderer.domElement.remove(); renderer.dispose(); }
    release(model); if (mounts.get(element) === handle) mounts.delete(element);
  } };
  mounts.set(element, handle);
  handle.ready = (async () => { try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.domElement.setAttribute('aria-hidden', 'true');
    renderer.domElement.addEventListener('webglcontextlost', lost); element.append(renderer.domElement);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2));
    const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(3, 4, 5); scene.add(light);
    const loader = new GLTFLoader(); configureLoader?.(loader, renderer);
    const gltf = await loader.loadAsync(config.modelUrl);
    if (disposed) { release(gltf.scene); return; }
    model = new THREE.Group(); model.add(gltf.scene); remember(model);
    const bounds = new THREE.Box3().setFromObject(gltf.scene);
    if (bounds.isEmpty()) throw Error('Model has no visible bounds; retain the static fallback');
    const center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
    fitRadius = size.length() / 2;
    if (!Number.isFinite(fitRadius) || fitRadius <= 0) throw Error('Model bounds are invalid; retain the static fallback');
    gltf.scene.position.sub(center); scene.add(model);
    model.rotation.y = config.rotationFrom; phase = 'ready'; element.dataset.uiModelState = phase;
    if (globalThis.IntersectionObserver) { observer = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting); if (visible) schedule(); }); observer.observe(element); }
    if (globalThis.ResizeObserver) { resizeObserver = new ResizeObserver(resize); resizeObserver.observe(element); }
    addEventListener('resize', resize, { passive: true }); addEventListener('scroll', schedule, { passive: true });
    document.addEventListener('visibilitychange', schedule); preference.addEventListener('change', schedule); resize();
  } catch (error) {
    if (!disposed) { fallback('unavailable'); handle.dispose(); }
    throw error;
  } })();
  return handle;
}
