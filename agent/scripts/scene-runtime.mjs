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
  // PCF honours a blur radius (PCFSoft does not): long, soft key-visual
  // shadows without the light bleeding of variance maps.
  renderer.shadowMap.type = spec.softShadows > 0 ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  const resources = [];
  if (spec.backgroundGradient) {
    // Painted backdrop (also what glass refracts). A soft radial glow sits
    // where the gradient turns light, like a lit studio wall.
    const g = spec.backgroundGradient, paint = document.createElement('canvas');
    paint.width = 1024; paint.height = Math.max(64, Math.round(1024 * spec.height / spec.width));
    const ctx = paint.getContext('2d'), a = (g.angle - 90) * Math.PI / 180, cx = paint.width / 2, cy = paint.height / 2, r = Math.hypot(cx, cy);
    const linear = ctx.createLinearGradient(cx - Math.cos(a) * r, cy - Math.sin(a) * r, cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    linear.addColorStop(0, g.from); linear.addColorStop(1, g.to);
    ctx.fillStyle = linear; ctx.fillRect(0, 0, paint.width, paint.height);
    if (g.glow > 0) {
      const gx = cx - Math.cos(a) * r * 0.35, gy = cy - Math.sin(a) * r * 0.35, radial = ctx.createRadialGradient(gx, gy, 0, gx, gy, r * 0.9);
      radial.addColorStop(0, `rgba(255,255,255,${0.55 * g.glow})`); radial.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalCompositeOperation = 'screen'; ctx.fillStyle = radial; ctx.fillRect(0, 0, paint.width, paint.height);
    }
    const texture = new THREE.CanvasTexture(paint);
    texture.colorSpace = THREE.SRGBColorSpace;
    scene.background = texture; resources.push(texture);
  } else scene.background = new THREE.Color(spec.background);
  const pmrem = new THREE.PMREMGenerator(renderer), room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04);
  scene.environment = environment.texture;
  room.dispose(); pmrem.dispose();
  const camera = new THREE.PerspectiveCamera(spec.camera.fov, spec.width / spec.height, 0.1, 500);
  camera.position.fromArray(spec.camera.position);
  const cameraTarget = new THREE.Vector3().fromArray(spec.camera.target);
  const objects = new Map();
  const geometry = (kind, definition) => {
    switch (kind) {
      case 'box': return new THREE.BoxGeometry(1, 1, 1);
      case 'sphere': return new THREE.SphereGeometry(1, 40, 24);
      case 'torus': return new THREE.TorusGeometry(1, definition.tube ?? 0.055, 24, 128, definition.arc ?? Math.PI * 2);
      case 'torusKnot': return new THREE.TorusKnotGeometry(0.65, definition.tube ?? 0.23, 160, 24);
      case 'arch': return new THREE.TorusGeometry(1, definition.tube ?? 0.22, 48, 160, definition.arc ?? Math.PI);
      case 'capsule': return new THREE.CapsuleGeometry(0.5, 1, 12, 32);
      case 'disc': return new THREE.CylinderGeometry(1, 1, 1, 96, 1);
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
      const shape = geometry(definition.geometry, definition);
      const common = { color: definition.color, transparent: definition.opacity < 1, opacity: definition.opacity };
      const kind = definition.material && definition.material !== 'auto' ? definition.material : spec.style === 'luminous' && definition.geometry !== 'plane' ? 'glass' : undefined;
      const material = kind === 'glass'
        // Frosted glass: transmission refracts the backdrop, roughness frosts
        // it, clearcoat gives the crisp rim highlight, iridescence the
        // thin-film sheen that reads as premium rather than plastic.
        ? new THREE.MeshPhysicalMaterial({ ...common, roughness: definition.roughness, metalness: 0, transmission: definition.transmission ?? 1, thickness: 1.1, ior: 1.46, clearcoat: 1, clearcoatRoughness: 0.08, iridescence: definition.iridescence ?? 0.3, iridescenceIOR: 1.35, attenuationColor: definition.color, attenuationDistance: 2.4, specularIntensity: 1 })
        : kind === 'matte' ? new THREE.MeshStandardMaterial({ ...common, roughness: Math.max(0.85, definition.roughness), metalness: 0 })
          : kind === 'metal' ? new THREE.MeshPhysicalMaterial({ ...common, roughness: definition.roughness, metalness: 1, clearcoat: 0.6, clearcoatRoughness: 0.15 })
            : kind === 'emissive' ? new THREE.MeshStandardMaterial({ ...common, emissive: definition.color, emissiveIntensity: definition.emissive ?? 2, roughness: definition.roughness })
              : spec.style === 'toon'
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
        : l.type === 'spot' ? new THREE.SpotLight(l.color, l.intensity, 0, l.angle, l.penumbra, 2)
          : new THREE.DirectionalLight(l.color, l.intensity);
    light.position.fromArray(l.position);
    if (l.type === 'spot') { light.target.position.fromArray(l.target); scene.add(light.target); }
    if (!shadowAssigned && (l.type === 'directional' || l.type === 'spot')) {
      light.castShadow = true; shadowAssigned = true;
      light.shadow.mapSize.set(spec.softShadows > 0 ? 2048 : 1024, spec.softShadows > 0 ? 2048 : 1024);
      if (l.type === 'directional') Object.assign(light.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 0.1, far: 80 });
      else Object.assign(light.shadow.camera, { near: 0.5, far: 80 });
      light.shadow.bias = -0.0003;
      if (spec.softShadows > 0) { light.shadow.radius = spec.softShadows; light.shadow.blurSamples = 24; }
    }
    scene.add(light);
  }
  // Volumetric shafts: additive planes along each beam, turned toward the
  // camera around their own axis, with a Gaussian cross-section and a fade
  // along the length. Cheap, deterministic and convincing at hero scale.
  const beams = (spec.beams ?? []).map(b => {
    const from = new THREE.Vector3().fromArray(b.from), to = new THREE.Vector3().fromArray(b.to);
    const axis = to.clone().sub(from), length = axis.length();
    const shape = new THREE.PlaneGeometry(b.width, length, 1, 1);
    const material = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { tint: { value: new THREE.Color(b.color) }, strength: { value: b.intensity } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 tint; uniform float strength; varying vec2 vUv; void main(){ float x = (vUv.x - 0.5) * 3.2; float across = exp(-x * x * 2.2); float along = smoothstep(0.0, 0.12, vUv.y) * (1.0 - smoothstep(0.45, 1.0, vUv.y)) * mix(1.0, 0.45, vUv.y); gl_FragColor = vec4(tint * across * along * strength * 0.55, 1.0); }' });
    const mesh = new THREE.Mesh(shape, material);
    mesh.position.copy(from.clone().add(to).multiplyScalar(0.5));
    mesh.renderOrder = 10;
    scene.add(mesh); resources.push(shape, material);
    return { mesh, axis: axis.normalize() };
  });
  const faceCamera = () => {
    for (const beam of beams) {
      const toCamera = camera.position.clone().sub(beam.mesh.position);
      const side = new THREE.Vector3().crossVectors(beam.axis, toCamera).normalize();
      if (side.lengthSq() < 1e-8) continue;
      const normal = new THREE.Vector3().crossVectors(side, beam.axis).normalize();
      beam.mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(side, beam.axis, normal));
    }
  };
  // Compositing layer over the WebGL canvas (captured with it): highlight
  // bloom, film grain that also hides gradient banding, and a vignette.
  const post = spec.post, stage = canvas.parentElement;
  let bloom, bloomContext, grain;
  if (post && stage) {
    if (post.bloom > 0) {
      bloom = document.createElement('canvas'); bloom.width = spec.width; bloom.height = spec.height; bloom.className = 'post';
      bloom.style.mixBlendMode = 'screen'; bloom.style.opacity = String(Math.min(1, post.bloom));
      bloomContext = bloom.getContext('2d'); stage.appendChild(bloom);
    }
    if (post.grain > 0) {
      grain = document.createElement('div'); grain.className = 'post';
      grain.style.backgroundImage = `url("data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>')}")`;
      grain.style.mixBlendMode = 'overlay'; grain.style.opacity = String(post.grain * 0.45);
      stage.appendChild(grain);
    }
    if (post.vignette > 0) {
      const vignette = document.createElement('div'); vignette.className = 'post';
      vignette.style.background = `radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 52%, rgba(0,0,0,${0.85 * post.vignette}) 100%)`;
      stage.appendChild(vignette);
    }
  }
  const composite = (time) => {
    if (bloomContext) {
      const scale = Math.max(1, post.bloom);
      bloomContext.clearRect(0, 0, spec.width, spec.height);
      bloomContext.filter = `brightness(0.7) contrast(${2.4 * scale}) blur(${post.bloomRadius}px)`;
      bloomContext.drawImage(canvas, 0, 0, spec.width, spec.height);
    }
    // Grain moves deterministically with time so video frames never freeze it.
    if (grain) grain.style.backgroundPosition = `${Math.round(Math.sin(time * 37.1) * 97)}px ${Math.round(Math.cos(time * 23.7) * 89)}px`;
  };
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
    faceCamera();
    renderer.render(scene, camera);
    const gl = renderer.getContext(); gl.finish();
    composite(time);
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
