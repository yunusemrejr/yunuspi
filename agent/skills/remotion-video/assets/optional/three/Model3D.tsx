import React, { useEffect, useMemo, useState } from "react";
import { ThreeCanvas } from "@remotion/three";
import { useThree } from "@react-three/fiber";
import { Box3, PMREMGenerator, Vector3, type Object3D } from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { cancelRender, continueRender, delayRender, staticFile, useCurrentFrame } from "remotion";
import { ease, progress } from "../motion";

/** Image-based light from a procedural studio room: metals and glass have
 * nothing to reflect without one, and render black under lamps alone. */
const Studio: React.FC<{ intensity: number }> = ({ intensity }) => {
  const { gl, scene } = useThree();
  useEffect(() => {
    const pmrem = new PMREMGenerator(gl);
    const target = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = target.texture;
    scene.environmentIntensity = intensity;
    return () => { scene.environment = null; target.dispose(); pmrem.dispose(); };
  }, [gl, scene, intensity]);
  return null;
};

/** A glTF/GLB model (Poly Haven, Blender exports, Sketchfab downloads) turned
 * on a turntable or pushed in on, lit for product-style shots. `src` is a path
 * under public/ (video_assets fetch puts models in assets/models/<id>/). The
 * model is centred and scaled to fit, so any asset frames the same way.
 * Rendering is software GL: keep textures at 1k and canvases modest. Every
 * value is a pure function of the frame. */
export const Model3D: React.FC<{
  src: string; width: number; height: number;
  /** Full turns over `over` frames; 0 holds still. */
  turns?: number; startAngle?: number; tilt?: number; over?: number; at?: number;
  /** Camera distance multiplier animating from `from` to `to` (push in / pull out). */
  from?: number; to?: number; fov?: number;
  light?: "studio" | "warm" | "cool";
}> = ({ src, width, height, turns = 0.5, startAngle = -0.6, tilt = 0.18, over = 240, at = 0, from = 1.25, to = 0.95, fov = 32, light = "studio" }) => {
  const frame = useCurrentFrame();
  const [object, setObject] = useState<Object3D | null>(null);
  const [handle] = useState(() => delayRender(`Loading ${src}`));
  useEffect(() => {
    new GLTFLoader().load(staticFile(src), (gltf) => { setObject(gltf.scene); continueRender(handle); }, undefined, (error) => cancelRender(error));
  }, [src, handle]);
  const fitted = useMemo(() => {
    if (!object) return null;
    const box = new Box3().setFromObject(object);
    const size = box.getSize(new Vector3()), centre = box.getCenter(new Vector3());
    return { scale: 2 / Math.max(size.x, size.y, size.z, 1e-6), centre };
  }, [object]);
  if (!object || !fitted) return null;
  const t = progress(frame, at, over, ease.inOut);
  const distance = (from + (to - from) * t) * (1.6 / Math.tan((fov * Math.PI) / 360));
  const rig = { studio: ["#ffffff", "#dfe8ff"], warm: ["#ffe3c2", "#b9a48f"], cool: ["#d6e6ff", "#8aa0c4"] }[light];
  return (
    <ThreeCanvas width={width} height={height} camera={{ fov, position: [0, distance * 0.28, distance] }} style={{ width, height }}>
      <Studio intensity={light === "studio" ? 1 : 0.7} />
      <hemisphereLight args={[rig[0], rig[1], 0.6]} />
      <directionalLight position={[3, 5, 4]} intensity={2.2} />
      <directionalLight position={[-4, 2, -3]} intensity={0.9} />
      <group rotation={[tilt, startAngle + turns * Math.PI * 2 * t, 0]} scale={fitted.scale}>
        <primitive object={object} position={[-fitted.centre.x, -fitted.centre.y, -fitted.centre.z]} />
      </group>
    </ThreeCanvas>
  );
};
