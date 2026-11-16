// Interactive 3D body: translucent "hologram" skin coloured by region status, with real organs inside.
// Model: HuBMAP CCF 3D Reference Object Library v1.2 (male skin, heart, lungs, kidneys, liver, spinal cord),
// CC BY 4.0, https://humanatlas.io — simplified and compressed into public/models/body.glb.
import { OrbitControls, useGLTF } from '@react-three/drei';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Suspense, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import * as THREE from 'three';
import type { OrbitControls as OrbitImpl } from 'three-stdlib';
import type { OrganId, RegionId, St } from '../lib/health';
import { useLang } from '../lib/i18n';

const MODEL = './models/body.glb';

const TINT: Record<St, THREE.Color> = {
  ok: new THREE.Color('#5fd38f'),
  att: new THREE.Color('#ffc23d'),
  crit: new THREE.Color('#ff5a4d'),
  none: new THREE.Color('#9fb0c8'),
};
const COL_WHITE = new THREE.Color('#ffffff');
const COL_DIM = new THREE.Color('#5b6b85');
const NO_RAYCAST = () => null;
const REGION_BOXES: { id: RegionId; pos: [number, number, number]; args: [number, number, number] }[] = [
  { id: 'head', pos: [0, 0.80, 0], args: [0.30, 0.24, 0.30] },
  { id: 'chest', pos: [0, 0.54, 0], args: [0.36, 0.26, 0.28] },
  { id: 'abdomen', pos: [0, 0.18, 0], args: [0.36, 0.44, 0.28] },
  { id: 'armL', pos: [0.32, 0.32, 0], args: [0.24, 0.70, 0.26] },
  { id: 'armR', pos: [-0.32, 0.32, 0], args: [0.24, 0.70, 0.26] },
  { id: 'legL', pos: [0.12, -0.49, 0], args: [0.22, 0.86, 0.28] },
  { id: 'legR', pos: [-0.12, -0.49, 0], args: [0.22, 0.86, 0.28] },
];
const ORGAN_COLOR: Record<string, string> = {
  heart: '#f0476b', lungs: '#64b4ff', kidneyL: '#f08a3e', kidneyR: '#f08a3e', liver: '#b2583c', spine: '#e9dfcf', brain: '#b08bff',
};
const ORGAN_OF: Record<string, OrganId | null> = { heart: 'coracao', lungs: 'pulmao', kidneyL: 'rins', kidneyR: 'rins', liver: 'figado', spine: null, brain: 'cerebro' };
const REGION_OF_ORGAN: Record<string, RegionId> = { heart: 'chest', lungs: 'chest', kidneyL: 'abdomen', kidneyR: 'abdomen', liver: 'abdomen', spine: 'chest', brain: 'head' };
const REGION_CENTER: Record<RegionId, [number, number]> = {
  head: [0, 0.8], chest: [0, 0.52], abdomen: [0, 0.2], armL: [0.32, 0.3], armR: [-0.32, 0.3], legL: [0.14, -0.5], legR: [-0.14, -0.5],
};

/** Region of a skin vertex, from its position (model frame: +x = body's left, +y = up, height ±0.915). */
export function regionAt(x: number, y: number): RegionId {
  if (y > 0.68) return 'head';
  if (y < -0.06) return x > 0 ? 'legL' : 'legR';
  if (Math.abs(x) > 0.19 && y < 0.67) return x > 0 ? 'armL' : 'armR';
  return y > 0.4 ? 'chest' : 'abdomen';
}

const holoVert = /* glsl */ `
  attribute vec3 color;
  varying vec3 vColor; varying vec3 vN; varying vec3 vView;
  void main() {
    vColor = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView = -mv.xyz;
    vN = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mv;
  }`;
const holoFrag = /* glsl */ `
  varying vec3 vColor; varying vec3 vN; varying vec3 vView;
  void main() {
    float f = pow(1.0 - abs(dot(normalize(vN), normalize(vView))), 2.2);
    vec3 c = mix(vColor * 0.85, vec3(1.0), f * 0.35);
    gl_FragColor = vec4(c, 0.1 + f * 0.8);
  }`;

function brainGeometry(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 64, 40);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = 1 + 0.05 * Math.sin(v.x * 14) * Math.sin(v.y * 17) * Math.sin(v.z * 12) - (Math.abs(v.x) < 0.06 && v.y > 0 ? 0.08 : 0);
    v.multiplyScalar(n);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

function Model({ status, organSt, selected, onSelect }: { status: Record<RegionId, St>; organSt: Partial<Record<OrganId, St>>; selected: RegionId | null; onSelect: (r: RegionId) => void }) {
  const { scene } = useGLTF(MODEL);
  const skinRef = useRef<THREE.Mesh | null>(null);
  const regions = useRef<RegionId[]>([]);
  const organMats = useRef<{ name: string; mat: THREE.MeshStandardMaterial }[]>([]);

  const holo = useMemo(
    () => new THREE.ShaderMaterial({ vertexShader: holoVert, fragmentShader: holoFrag, transparent: true, depthWrite: false, side: THREE.FrontSide }),
    [],
  );

  // one-time setup: classify skin vertices, give organs their materials
  const root = useMemo(() => {
    const r = scene.clone(true);
    r.updateMatrixWorld(true);
    organMats.current = [];
    r.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.raycast = NO_RAYCAST;
      if (m.name.startsWith('skin')) {
        const geo = (m.geometry as THREE.BufferGeometry).clone();
        m.geometry = geo;
        const pos = geo.attributes.position;
        const v = new THREE.Vector3();
        const reg: RegionId[] = new Array(pos.count);
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
          reg[i] = regionAt(v.x, v.y);
        }
        regions.current = reg;
        geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3));
        m.material = holo;
        m.renderOrder = 2;
        skinRef.current = m;
      } else {
        const key = Object.keys(ORGAN_COLOR).find((k) => m.name.startsWith(k)) ?? 'spine';
        const mat = new THREE.MeshStandardMaterial({ color: ORGAN_COLOR[key], roughness: 0.45, metalness: 0.05, emissive: new THREE.Color(ORGAN_COLOR[key]), emissiveIntensity: 0.12 });
        m.material = mat;
        m.userData.organ = key;
        organMats.current.push({ name: key, mat });
      }
    });
    return r;
  }, [scene, holo]);

  const brain = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({ color: ORGAN_COLOR.brain, roughness: 0.5, emissive: new THREE.Color(ORGAN_COLOR.brain), emissiveIntensity: 0.12 });
    organMats.current = organMats.current.filter((o) => o.name !== 'brain').concat([{ name: 'brain', mat }]);
    return { geo: brainGeometry(), mat };
  }, [root]);

  const statusKey = `${status.head}|${status.chest}|${status.abdomen}|${status.armL}|${status.armR}|${status.legL}|${status.legR}|${selected ?? ''}`;

  // colour the skin by region status; the selected region is brighter, the rest a little dimmer
  useEffect(() => {
    const m = skinRef.current;
    if (!m) return;
    const col = (m.geometry as THREE.BufferGeometry).attributes.color as THREE.BufferAttribute;
    const tmp = new THREE.Color();
    const reg = regions.current;
    for (let i = 0; i < reg.length; i++) {
      const r = reg[i];
      tmp.copy(TINT[status[r]]);
      if (selected) tmp.lerp(r === selected ? COL_WHITE : COL_DIM, r === selected ? 0.25 : 0.45);
      col.setXYZ(i, tmp.r, tmp.g, tmp.b);
    }
    col.needsUpdate = true;
  }, [statusKey, root]); // eslint-disable-line react-hooks/exhaustive-deps

  // organs needing attention pulse gently (never for "no data")
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    for (const o of organMats.current) {
      const id = ORGAN_OF[o.name];
      const st = id ? organSt[id] : undefined;
      const sel = selected && REGION_OF_ORGAN[o.name] === selected;
      const pulse = st === 'crit' ? 0.55 + 0.45 * Math.sin(t * 5) : st === 'att' ? 0.3 + 0.25 * Math.sin(t * 2.4) : 0.12;
      o.mat.emissiveIntensity = sel ? Math.max(pulse, 0.35) : pulse;
      o.mat.color.set(st === 'none' ? '#8d99ab' : ORGAN_COLOR[o.name]);
    }
  });

  function hitRegion(r: RegionId, e: ThreeEvent<MouseEvent>) {
    if (e.delta > 6) return; // it was a drag
    e.stopPropagation();
    onSelect(r);
  }

  return (
    <group>
      <primitive object={root} />
      <mesh geometry={brain.geo} material={brain.mat} position={[0, 0.835, 0.015]} scale={[0.066, 0.054, 0.084]} raycast={NO_RAYCAST} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.93, 0]} raycast={NO_RAYCAST}>
        <ringGeometry args={[0.32, 0.36, 64]} />
        <meshBasicMaterial color="#5c8dff" transparent opacity={0.45} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.931, 0]} raycast={NO_RAYCAST}>
        <circleGeometry args={[0.32, 64]} />
        <meshBasicMaterial color="#5c8dff" transparent opacity={0.08} />
      </mesh>
      {REGION_BOXES.map((b) => (
        <mesh key={b.id} position={b.pos} onClick={(e) => hitRegion(b.id, e)}>
          <boxGeometry args={b.args} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
        </mesh>
      ))}
    </group>
  );
}

/** Moves the camera towards the selected region (focus mode) or back to the whole body. */
function Rig({ selected, focus, controls }: { selected: RegionId | null; focus: boolean; controls: RefObject<OrbitImpl> }) {
  const { camera } = useThree();
  const target = useRef(new THREE.Vector3());
  useFrame(() => {
    const c = controls.current;
    if (!c) return;
    const [x, y] = selected && focus ? REGION_CENTER[selected] : [0, 0];
    target.current.set(x * 0.5, y * (focus && selected ? 0.9 : 1), 0);
    c.target.lerp(target.current, 0.08);
    const want = focus && selected ? 2.0 : 3.25;
    const dir = camera.position.clone().sub(c.target);
    const d = dir.length();
    if (Math.abs(d - want) > 0.005) camera.position.copy(c.target).add(dir.setLength(d + (want - d) * 0.08));
    c.update();
  });
  return null;
}

function hasWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

export default function Body3D({
  status, organSt, selected, onSelect, label, focus = true,
}: { status: Record<RegionId, St>; organSt: Partial<Record<OrganId, St>>; selected: RegionId | null; onSelect: (r: RegionId) => void; label: string; focus?: boolean }) {
  const { t } = useLang();
  const controls = useRef<OrbitImpl>(null);
  const [touched, setTouched] = useState(false);
  const [ok] = useState(hasWebGL);
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!ok) return null;
  return (
    <div className="body3d" role="img" aria-label={label} onPointerDown={() => setTouched(true)}>
      <Canvas camera={{ position: [0, 0.05, 3.25], fov: 34, near: 0.1, far: 20 }} dpr={[1, 2]} gl={{ antialias: true, alpha: true }}>
        <ambientLight intensity={0.7} />
        <hemisphereLight args={['#cfe0ff', '#1b2a44', 0.8]} />
        <directionalLight position={[1.5, 2.5, 2.5]} intensity={1.6} />
        <directionalLight position={[-2, 1, -2]} intensity={0.6} color="#7fa0ff" />
        <Suspense fallback={null}>
          <Model status={status} organSt={organSt} selected={selected} onSelect={onSelect} />
        </Suspense>
        <OrbitControls
          ref={controls}
          enablePan={false}
          enableZoom
          minDistance={1.5}
          maxDistance={3.6}
          minPolarAngle={Math.PI / 2.8}
          maxPolarAngle={Math.PI / 1.6}
          enableDamping
          rotateSpeed={0.7}
          autoRotate={!touched && !reduce && !selected}
          autoRotateSpeed={0.8}
        />
        <Rig selected={selected} focus={focus} controls={controls} />
      </Canvas>
      {!touched && (
        <span className="hint3d" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7 M21 4v5h-5" /></svg>
          {t('dragToRotate')}
        </span>
      )}
    </div>
  );
}

useGLTF.preload(MODEL);
