import type { AvatarSpec } from "@pickle/protocol";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { breathScale, useBreathing, useOnScreen } from "../motion/breathing";
import { useTierValue } from "../motion/tier";
import { DEFAULT_AVATAR } from "../ui/Avatar";
import { BODY_SCALE, DRIFT, EYE_SCALE, WOBBLE, eyeOffset, eyeRig } from "./blobSurface";

/**
 * The agent character in 3D (MOTION-SPEC §6.1 / §10) — LAZY CHUNK ONLY (import through AgentBlobLazy).
 * A soft blob (sphere displaced by low-frequency noise, fake subsurface: wrap lighting + soft rim + sheen), two eyes,
 * breathing per MOTION-SPEC §8.11 (period 3.2 s, scale 1 → 1.02), follows the pointer ±6°, `amplitude` (0..1, voice)
 * adds a quick ripple and a small swell (voiceResponse: room noise stays still); the eyes ride the surface (blobSurface.ts), so neither the drift nor the wobble ever covers
 * them. The uniforms are handed to the material's constructor: as a prop R3F copies each one ({...u}) and the frame
 * loop's uTime/uAmp writes would never reach the GPU (until 2026-11-12 the surface was frozen and calls did not move
 * it). The render loop runs ONLY while on screen + visible AND (within 10 s of input, or a live voice
 * amplitude); otherwise one still frame is drawn and the loop stops (§8.16 idle cost). Reduced motion: still pose.
 * Costs: MSAA at every size (the silhouette and the eyes are mesh edges: without it they stair-step, visibly from
 * ~120 px); DPR ≤ 1.5 below DPR2_MIN (the agent sheet's 120 px), ≤ 2 from it (onboarding and call 208 px).
 * Low-power GPU. The canvas never takes pointer events.
 */
export interface AgentBlobProps {
  size?: number;
  spec?: AvatarSpec;
  amplitude?: number;
  className?: string;
  onReady?: () => void;
  onLost?: () => void;
}

const vert = /* glsl */ `
uniform float uTime;
uniform float uAmp;
varying vec3 vNormal;
varying vec3 vView;
varying float vLift;
void main() {
  vec3 p = position;
  float t = uTime * 0.35;
  float n = sin(p.x * 1.7 + t) * sin(p.y * 1.3 + t * 0.8) * sin(p.z * 1.5 + t * 1.1);
  float wob = sin(p.y * 7.0 + uTime * 11.0) * sin(p.x * 5.0 + uTime * 7.0);
  // flatten the base a little (mochi), keep the top round
  p.y = p.y < -0.55 ? -0.55 + (p.y + 0.55) * 0.45 : p.y;
  p += normal * (n * ${DRIFT.toFixed(3)} + wob * ${WOBBLE.toFixed(3)} * uAmp); // = surfaceLift (blobSurface.ts)
  vLift = p.y;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

const frag = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uLight;
uniform vec3 uDeep;
varying vec3 vNormal;
varying vec3 vView;
varying float vLift;
void main() {
  vec3 n = normalize(vNormal);
  vec3 l = normalize(vec3(-0.55, 0.75, 0.6));
  float wrap = clamp((dot(n, l) + 0.55) / 1.55, 0.0, 1.0);
  vec3 col = mix(uDeep, uColor, wrap);
  // translucency at grazing angles reads as subsurface
  float rim = pow(1.0 - clamp(dot(n, vView), 0.0, 1.0), 2.4);
  col = mix(col, uLight, rim * 0.42);
  // soft sheen + a small specular
  vec3 h = normalize(l + vView);
  float spec = pow(max(dot(n, h), 0.0), 36.0);
  col += vec3(1.0) * spec * 0.32;
  col += uLight * smoothstep(0.2, 1.0, vLift) * 0.06;
  gl_FragColor = vec4(col, 1.0);
}
`;

function hslColor(h: number, s: number, l: number) {
  // the shader writes raw values (no colour management): hand it sRGB components
  const rgb = new THREE.Color();
  new THREE.Color().setHSL(h / 360, s, l, THREE.SRGBColorSpace).getRGB(rgb, THREE.SRGBColorSpace);
  return new THREE.Vector3(rgb.r, rgb.g, rgb.b);
}

const DEG6 = (6 * Math.PI) / 180;
/** a call's speech level (0..1, quiet speech ≈ 0.1, loud ≈ 0.4) → how much the character moves: room noise below 0.03
 * stays still, ordinary speech reads clearly */
const voiceResponse = (level: number) => Math.min(1, Math.max(0, (level - 0.03) / 0.35)) ** 0.7;
const VOICE_SWELL = 0.03;
/** from this size (CSS px) up the character is drawn at DPR ≤ 2 (below: ≤ 1.5) */
const DPR2_MIN = 160;

function Blob({ spec, amplitude, still, onFirstFrame }: { spec: AvatarSpec; amplitude: number; still: boolean; onFirstFrame: () => void }) {
  const group = useRef<THREE.Group>(null);
  const amp = useRef(amplitude);
  amp.current = amplitude;
  const stillRef = useRef(still);
  stillRef.current = still;
  const t0 = useRef<number | null>(null);
  const invalidate = useThree((s) => s.invalidate);
  // going still: draw one frame in the rest pose (the loop has stopped)
  useEffect(() => {
    if (still) {
      t0.current = null;
      invalidate();
    }
  }, [still, invalidate]);
  const first = useRef(false);
  const h = ((spec.hue % 360) + 360) % 360;
  // ONE uniforms object, handed to the material's constructor so the material holds THESE objects (see the header);
  // a new character (a login, 나의 모시) recolours the same vectors in place
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uAmp: { value: 0 },
      uColor: { value: new THREE.Vector3() },
      uLight: { value: new THREE.Vector3() },
      uDeep: { value: new THREE.Vector3() },
    }),
    [],
  );
  const material = useMemo((): [THREE.ShaderMaterialParameters] => [{ vertexShader: vert, fragmentShader: frag, uniforms }], [uniforms]);
  const painted = useRef<number | null>(null);
  if (painted.current !== h) {
    painted.current = h;
    uniforms.uColor.value.copy(hslColor(h, 0.8, 0.58));
    uniforms.uLight.value.copy(hslColor(h, 0.95, 0.8));
    uniforms.uDeep.value.copy(hslColor(h, 0.72, 0.38));
  }
  useEffect(() => invalidate(), [h, invalidate]);
  const eyeColor = useMemo(() => new THREE.Color().setHSL(h / 360, 0.45, 0.1, THREE.SRGBColorSpace), [h]);
  const eyeScale = spec.eyes === "dot" ? EYE_SCALE.dot : EYE_SCALE.oval;
  const rigs = useMemo(() => [eyeRig(-1, spec.eyes), eyeRig(1, spec.eyes)] as const, [spec.eyes]);
  const eyes = useRef<(THREE.Group | null)[]>([]);
  const at = useRef<[number, number, number]>([0, 0, 0]);

  useFrame((state, delta) => {
    const g = group.current;
    if (!g) return;
    const now = state.clock.elapsedTime;
    const still = stillRef.current;
    if (!still && t0.current === null) t0.current = now; // breathing starts from the rest pose
    const t = still ? 0 : now - (t0.current ?? now);
    // the surface's own clock only runs while the character animates, so it resumes from the pose it stopped in
    // (a wall clock would jump the drift after every idle pause)
    if (!still) uniforms.uTime.value += Math.min(delta, 0.1);
    const k = 1 - Math.exp(-Math.min(delta, 0.1) * 8);
    uniforms.uAmp.value += (voiceResponse(amp.current) - uniforms.uAmp.value) * k;
    const px = Math.max(-1, Math.min(1, state.pointer.x));
    const py = Math.max(-1, Math.min(1, state.pointer.y));
    const f = 1 - Math.exp(-Math.min(delta, 0.1) * 5);
    g.rotation.y += (px * DEG6 - g.rotation.y) * f;
    g.rotation.x += (-py * DEG6 - g.rotation.x) * f;
    // the voice also swells the whole character a little (eyes included), on top of the breath
    g.scale.setScalar(still ? 1 : breathScale(t) * (1 + VOICE_SWELL * uniforms.uAmp.value));
    if (still) {
      g.rotation.set(0, 0, 0);
      uniforms.uAmp.value = 0;
    }
    // the eyes ride the surface the shader draws this frame
    rigs.forEach((rig, i) => eyes.current[i]?.position.set(...eyeOffset(rig, uniforms.uTime.value, uniforms.uAmp.value, at.current)));
    if (!first.current) {
      first.current = true;
      requestAnimationFrame(onFirstFrame);
    }
  });

  return (
    <group ref={group}>
      <mesh scale={BODY_SCALE as [number, number, number]}>
        <sphereGeometry args={[1, 64, 48]} />
        <shaderMaterial args={material} />
      </mesh>
      {rigs.map((rig, i) => (
        <group
          key={i}
          ref={(el) => {
            eyes.current[i] = el;
          }}
          position={rig.base}
        >
          <mesh scale={eyeScale as unknown as [number, number, number]}>
            <sphereGeometry args={[1, 20, 16]} />
            <meshBasicMaterial color={eyeColor} toneMapped={false} />
          </mesh>
          <mesh position={[-0.022, spec.eyes === "dot" ? 0.03 : 0.045, 0.045]} scale={0.022}>
            <sphereGeometry args={[1, 10, 8]} />
            <meshBasicMaterial color="#ffffff" toneMapped={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

export default function AgentBlob({ size = 160, spec = DEFAULT_AVATAR, amplitude = 0, className, onReady, onLost }: AgentBlobProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const reduce = useTierValue("reduceMotion");
  const breathing = useBreathing(wrap);
  const shown = useOnScreen(wrap, "80px");
  const running = !reduce && shown && (breathing || amplitude > 0.01);
  const lostRef = useRef(onLost);
  lostRef.current = onLost;
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  const frameloop = running ? "always" : "demand";
  return (
    <div ref={wrap} className={className} style={{ width: size, height: size, pointerEvents: "none" }} aria-hidden="true">
      <Canvas
        flat
        frameloop={frameloop}
        dpr={size >= DPR2_MIN ? [1, 2] : [1, 1.5]}
        gl={{ antialias: true, powerPreference: "low-power", alpha: true }}
        camera={{ position: [0, 0, 4.4], fov: 30 }}
        eventSource={typeof document !== "undefined" ? document.body : undefined}
        eventPrefix="client"
        style={{ pointerEvents: "none" }}
        onCreated={(state) => {
          state.gl.setClearColor(0x000000, 0);
          state.gl.domElement.addEventListener(
            "webglcontextlost",
            (e) => {
              e.preventDefault();
              lostRef.current?.();
            },
            { once: true },
          );
        }}
      >
        <Blob spec={spec} amplitude={amplitude} still={!running} onFirstFrame={() => readyRef.current?.()} />
      </Canvas>
    </div>
  );
}
