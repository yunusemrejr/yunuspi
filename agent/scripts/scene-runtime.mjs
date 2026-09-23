// This function is embedded verbatim in the self-contained scene viewer.
export function sceneRuntime(THREE, RoomEnvironment, spec, sampleKeys) {
  const canvas = document.querySelector('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false });
  renderer.setPixelRatio(1);
  renderer.setSize(spec.width, spec.height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = spec.exposure;
  renderer.shadowMap.enabled = spec.style !== 'wireframe';
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(spec.background);
  const pmrem = new THREE.PMREMGenerator(renderer), room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04);
  scene.environment = environment.texture;
  room.dispose(); pmrem.dispose();
  const camera = new THREE.PerspectiveCamera(spec.camera.fov, spec.width / spec.height, 0.1, 500);
  camera.position.fromArray(spec.camera.position);
  const cameraTarget = new THREE.Vector3().fromArray(spec.camera.target);
  const objects = new Map(), resources = [];
  const geometry = (kind) => {
    switch (kind) {
      case 'box': return new THREE.BoxGeometry(1, 1, 1);
      case 'sphere': return new THREE.SphereGeometry(1, 40, 24);
      case 'torus': return new THREE.TorusGeometry(1, 0.055, 12, 96);
      case 'torusKnot': return new THREE.TorusKnotGeometry(0.65, 0.23, 96, 16);
      case 'cone': return new THREE.ConeGeometry(1, 2, 32);
      case 'cylinder': return new THREE.CylinderGeometry(1, 1, 1, 40);
      case 'icosahedron': return new THREE.IcosahedronGeometry(1, 0);
      case 'plane': return new THREE.PlaneGeometry(1, 1);
    }
  };
  const ramp = new THREE.DataTexture(new Uint8Array([55, 125, 200, 255]), 4, 1, THREE.RedFormat);
  ramp.minFilter = ramp.magFilter = THREE.NearestFilter; ramp.needsUpdate = true;
  resources.push(ramp);
  for (const definition of spec.objects) {
    let mesh;
    if (definition.geometry === 'group') mesh = new THREE.Group();
    else {
      const shape = geometry(definition.geometry);
      const common = { color: definition.color, transparent: definition.opacity < 1, opacity: definition.opacity };
      const material = spec.style === 'toon'
        ? new THREE.MeshToonMaterial({ ...common, gradientMap: ramp })
        : spec.style === 'wireframe'
          ? new THREE.MeshBasicMaterial({ ...common, wireframe: true })
          : new THREE.MeshStandardMaterial({ ...common, roughness: spec.style === 'clay' ? 0.9 : definition.roughness, metalness: spec.style === 'clay' ? 0 : definition.metalness, flatShading: definition.geometry === 'icosahedron' });
      mesh = new THREE.Mesh(shape, material);
      mesh.castShadow = definition.geometry !== 'plane'; mesh.receiveShadow = true;
      resources.push(shape, material);
    }
    mesh.position.fromArray(definition.position);
    mesh.rotation.set(...definition.rotation);
    mesh.scale.fromArray(definition.scale);
    objects.set(definition.id, mesh);
  }
  for (const definition of spec.objects) (definition.parent ? objects.get(definition.parent) : scene).add(objects.get(definition.id));
  let shadowAssigned = false;
  for (const l of spec.lights) {
    const light = l.type === 'hemisphere' ? new THREE.HemisphereLight(l.color, l.ground, l.intensity)
      : l.type === 'point' ? new THREE.PointLight(l.color, l.intensity, 100, 2)
        : new THREE.DirectionalLight(l.color, l.intensity);
    light.position.fromArray(l.position);
    if (!shadowAssigned && l.type === 'directional') {
      light.castShadow = true; shadowAssigned = true;
      light.shadow.mapSize.set(1024, 1024);
      Object.assign(light.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 0.1, far: 80 });
      light.shadow.bias = -0.0003;
    }
    scene.add(light);
  }
  const renderAt = (rawTime) => {
    if (!Number.isFinite(rawTime)) throw Error('Frame time must be finite');
    const time = Math.max(0, Math.min(spec.duration, rawTime));
    for (const track of spec.tracks) {
      const value = sampleKeys(track.keys, time);
      if (track.target === 'camera') {
        if (track.property === 'fov') camera.fov = value;
        else (track.property === 'target' ? cameraTarget : camera.position).fromArray(value);
      } else {
        const target = objects.get(track.target);
        if (track.property === 'rotation') target.rotation.set(...value);
        else target[track.property].fromArray(value);
      }
    }
    camera.lookAt(cameraTarget); camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    const gl = renderer.getContext(); gl.finish();
    if (gl.isContextLost()) throw Error('WebGL context lost during rendering');
    return { time, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, threeRevision: THREE.REVISION, backend: gl.getParameter(gl.RENDERER) };
  };
  window.sceneStudio = { renderAt, spec, metrics: renderAt(0) };
  const play = document.querySelector('#play'), seek = document.querySelector('#seek'), timeLabel = document.querySelector('#time');
  document.querySelector('#title').textContent = spec.title;
  seek.max = String(spec.duration);
  let playing = false, origin = 0;
  const showTime = time => { seek.value = String(time); timeLabel.textContent = `${time.toFixed(2)} / ${spec.duration.toFixed(2)} s`; };
  seek.addEventListener('input', () => { playing = false; play.textContent = 'Play'; renderAt(Number(seek.value)); showTime(Number(seek.value)); });
  play.addEventListener('click', () => { playing = !playing; play.textContent = playing ? 'Pause' : 'Play'; origin = performance.now() / 1000 - Number(seek.value); });
  renderer.setAnimationLoop(() => {
    if (!playing) return;
    const time = (performance.now() / 1000 - origin) % spec.duration;
    renderAt(time); showTime(time);
  });
  showTime(0);
  window.addEventListener('pagehide', () => {
    renderer.setAnimationLoop(null);
    for (const resource of resources) resource.dispose();
    environment.dispose(); renderer.dispose(); renderer.forceContextLoss();
  }, { once: true });
}
