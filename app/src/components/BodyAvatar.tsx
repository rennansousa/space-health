import { useId, useRef, useState, type PointerEvent } from 'react';
import type { OrganId, RegionId, St } from '../lib/health';

// Astronaut biometric silhouette coordinate paths (ViewBox: 240 x 500, Center X = 120)
const ARM_R =
  'M64 110 C 50 114 42 126 40 144 L 35 208 C 33 234 31 256 29 274 C 27 286 29 296 33 302 C 38 306 44 302 45 294 L 47 274 C 51 252 55 230 57 208 L 61 160 Z';
const LEG_R =
  'M74 284 C 88 294 106 296 117 292 L 115 350 C 114 390 111 428 109 468 C 109 478 103 484 93 484 L 83 484 C 79 480 81 474 85 470 L 87 468 C 85 428 79 390 75 350 C 71 324 68 302 74 284 Z';

function mirror(d: string): string {
  let i = 0;
  return d.replace(/-?\d+(\.\d+)?/g, (n) => (i++ % 2 === 0 ? String(240 - Number(n)) : n));
}

export const REGION_PATHS: Record<RegionId, string> = {
  head: 'M120 16 C 140 16 150 32 150 54 C 150 76 138 88 120 88 C 102 88 90 76 90 54 C 90 32 100 16 120 16 Z M108 84 L132 84 L134 96 L106 96 Z',
  chest:
    'M104 96 C 92 98 78 102 68 108 C 58 114 54 126 56 142 L 59 174 C 62 192 68 202 76 206 L 164 206 C 172 202 178 192 181 174 L 184 142 C 186 126 182 114 172 108 C 162 102 148 98 136 96 Z',
  abdomen: 'M76 210 L 164 210 C 162 232 160 254 166 278 C 148 290 92 290 74 278 C 80 254 78 232 76 210 Z',
  armR: ARM_R,
  armL: mirror(ARM_R),
  legR: LEG_R,
  legL: mirror(LEG_R),
};

// High-tech holographic translucent fills with neon status glow
const STATUS_THEME: Record<St, { fillStart: string; fillEnd: string; stroke: string; glow: string }> = {
  ok: {
    fillStart: 'rgba(16, 185, 129, 0.28)',
    fillEnd: 'rgba(5, 150, 105, 0.42)',
    stroke: '#34d399',
    glow: 'rgba(52, 211, 153, 0.55)',
  },
  att: {
    fillStart: 'rgba(245, 158, 11, 0.32)',
    fillEnd: 'rgba(180, 83, 9, 0.48)',
    stroke: '#fbbf24',
    glow: 'rgba(251, 191, 36, 0.65)',
  },
  crit: {
    fillStart: 'rgba(239, 68, 68, 0.38)',
    fillEnd: 'rgba(185, 28, 28, 0.55)',
    stroke: '#f87171',
    glow: 'rgba(248, 113, 113, 0.75)',
  },
  none: {
    fillStart: 'rgba(30, 58, 102, 0.28)',
    fillEnd: 'rgba(15, 28, 50, 0.42)',
    stroke: '#38bdf8',
    glow: 'rgba(56, 189, 248, 0.35)',
  },
};

// Futuristic astronaut suit seam contours
const SUIT_CONTOURS =
  'M86 106 C 98 112 110 110 118 104 M122 104 C 130 110 142 112 154 106 M76 138 C 92 152 108 152 118 144 M122 144 C 132 152 148 152 164 138 M120 102 L120 202 M98 222 L142 222 M96 242 L144 242 M98 262 L142 262 M120 208 L120 282 M90 380 C 96 385 102 385 106 380 M134 380 C 138 385 144 385 150 380 M50 196 C 54 200 58 200 60 196 M190 196 C 186 200 182 200 180 196';

export interface BodyAvatarProps {
  status: Record<RegionId, St>;
  organSt?: Partial<Record<OrganId, St>>;
  selected: RegionId | null;
  onSelect: (r: RegionId) => void;
  label: string;
  showTelemetry?: boolean;
}

export function BodyAvatar({
  status,
  organSt = {},
  selected,
  onSelect,
  label,
  showTelemetry = true,
}: BodyAvatarProps) {
  const uid = useId().replace(/:/g, '');
  const stage = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const [hoverRegion, setHoverRegion] = useState<RegionId | null>(null);
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function move(e: PointerEvent) {
    if (reduce || !stage.current) return;
    const r = stage.current.getBoundingClientRect();
    setTilt({
      x: ((e.clientX - r.left) / r.width - 0.5) * 18,
      y: -((e.clientY - r.top) / r.height - 0.5) * 10,
    });
  }

  const ids = Object.keys(REGION_PATHS) as RegionId[];

  return (
    <div
      ref={stage}
      className="body-stage holo-scanner"
      onPointerMove={move}
      onPointerLeave={() => {
        setTilt({ x: 0, y: 0 });
        setHoverRegion(null);
      }}
    >
      {/* Top HUD Telemetry Bar */}
      <div className="holo-hud-top">
        <span className="holo-hud-pill">
          <span className="holo-dot" />
          BIO-SCAN // 3D HOLOGRAM
        </span>
        <span className="holo-hud-coords">OSDR-575 · EVA READY</span>
      </div>

      <svg
        viewBox="0 0 240 500"
        role="img"
        aria-label={label}
        className="body-svg holo-projection"
        style={{
          transform: `perspective(900px) rotateY(${tilt.x}deg) rotateX(${tilt.y}deg)`,
        }}
      >
        <defs>
          {/* Holographic glowing linear gradients for each health status */}
          {(Object.keys(STATUS_THEME) as St[]).map((s) => (
            <linearGradient key={s} id={`${uid}-g-${s}`} x1="0" y1="0" x2="0.8" y2="1">
              <stop offset="0%" stopColor={STATUS_THEME[s].fillStart} />
              <stop offset="100%" stopColor={STATUS_THEME[s].fillEnd} />
            </linearGradient>
          ))}

          {/* Glass sheen overlay */}
          <radialGradient id={`${uid}-sheen`} cx="0.4" cy="0.18" r="0.8">
            <stop offset="0%" stopColor="#c7f9ff" stopOpacity="0.4" />
            <stop offset="50%" stopColor="#38bdf8" stopOpacity="0.06" />
            <stop offset="100%" stopColor="#0284c7" stopOpacity="0" />
          </radialGradient>

          {/* Hologram floor emitter rings */}
          <radialGradient id={`${uid}-floor`} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.65" />
            <stop offset="60%" stopColor="#0284c7" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#0b1526" stopOpacity="0" />
          </radialGradient>

          {/* Cyan glow filter */}
          <filter id={`${uid}-glow`} x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>

          {/* Selected target pulse filter */}
          <filter id={`${uid}-sel-glow`} x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>

          <clipPath id={`${uid}-clip`}>
            {ids.map((id) => (
              <path key={id} d={REGION_PATHS[id]} />
            ))}
          </clipPath>
        </defs>

        {/* --- Holographic Emitter Pedestal (3D Base) --- */}
        <g className="holo-base" pointerEvents="none">
          <ellipse cx="120" cy="486" rx="98" ry="14" fill={`url(#${uid}-floor)`} />
          <ellipse cx="120" cy="486" rx="82" ry="11" fill="none" stroke="#38bdf8" strokeOpacity="0.6" strokeWidth="1.2" />
          <ellipse cx="120" cy="486" rx="104" ry="15" fill="none" stroke="#38bdf8" strokeOpacity="0.3" strokeDasharray="4 6" />
          <ellipse cx="120" cy="486" rx="56" ry="7" fill="none" stroke="#67e8f9" strokeOpacity="0.75" strokeWidth="1.5" />
          {/* Vertical emitter light beams */}
          <line x1="38" y1="486" x2="38" y2="440" stroke="#38bdf8" strokeOpacity="0.2" strokeWidth="1" strokeDasharray="2 4" />
          <line x1="202" y1="486" x2="202" y2="440" stroke="#38bdf8" strokeOpacity="0.2" strokeWidth="1" strokeDasharray="2 4" />
        </g>

        {/* --- Astronaut Suit Body Regions --- */}
        {ids.map((id) => {
          const st = status[id] ?? 'none';
          const theme = STATUS_THEME[st];
          const isSel = selected === id;
          const isHov = hoverRegion === id;

          return (
            <path
              key={id}
              d={REGION_PATHS[id]}
              fill={`url(#${uid}-g-${st})`}
              stroke={isSel ? '#ffffff' : isHov ? '#a5f3fc' : theme.stroke}
              strokeWidth={isSel ? 2.8 : isHov ? 2 : 1.2}
              strokeOpacity={isSel ? 1 : 0.85}
              filter={isSel ? `url(#${uid}-sel-glow)` : undefined}
              className={`region holo-region${isSel ? ' sel' : ''}`}
              onClick={() => onSelect(id)}
              onPointerEnter={() => setHoverRegion(id)}
            />
          );
        })}

        {/* --- Holographic Organs & Inner Circuitry (Clipped to body) --- */}
        <g clipPath={`url(#${uid}-clip)`} pointerEvents="none">
          <rect x="0" y="0" width="240" height="500" fill={`url(#${uid}-sheen)`} />

          {/* Helmet Visor Reflection & Neuro-Glow */}
          <path
            d="M102 32 C 102 24 112 20 120 20 C 128 20 138 24 138 32 L 138 60 C 138 68 130 72 120 72 C 110 72 102 68 102 60 Z"
            fill="rgba(11, 25, 48, 0.75)"
            stroke="#38bdf8"
            strokeWidth="1"
            strokeOpacity="0.6"
          />

          {/* 1. BRAIN (Cerebral Neuro-Hologram) */}
          <g className="holo-organ-brain" opacity={organSt.cerebro === 'crit' ? 1 : 0.88}>
            <path
              d="M104 38 C 104 28 114 24 120 28 C 126 24 136 28 136 38 C 139 46 133 54 126 54 C 123 58 117 58 114 54 C 107 54 101 46 104 38 Z"
              fill="#c084fc"
              filter={`url(#${uid}-glow)`}
            />
            {/* Synaptic pulse lines */}
            <path d="M110 36 L120 44 L130 36 M115 48 L120 44 L125 48" stroke="#f3e8ff" strokeWidth="1" strokeLinecap="round" opacity="0.9" />
          </g>

          {/* 2. LUNGS (Bilateral Pulmonary Chambers) */}
          <g className="holo-organ-lungs" opacity={organSt.pulmao === 'crit' ? 1 : 0.85}>
            {/* Right lung (viewer's left) */}
            <path
              d="M115 126 C 103 122 91 134 91 154 C 91 168 97 176 105 174 C 113 172 115 164 115 154 Z"
              fill="#38bdf8"
              filter={`url(#${uid}-glow)`}
            />
            {/* Left lung (viewer's right) */}
            <path
              d="M125 126 C 137 122 149 134 149 154 C 149 168 143 176 135 174 C 127 172 125 164 125 154 Z"
              fill="#38bdf8"
              filter={`url(#${uid}-glow)`}
            />
            {/* Bronchial tree traces */}
            <path d="M120 120 L120 134 M120 134 L107 148 M120 134 L133 148" stroke="#e0f2fe" strokeWidth="1.2" strokeLinecap="round" opacity="0.75" />
          </g>

          {/* 3. HEART (Pulsing Cardiac Node) */}
          <g className="holo-organ-heart">
            <circle cx="127" cy="155" r="14" fill="rgba(244, 63, 94, 0.25)" filter={`url(#${uid}-glow)`} />
            <path
              d="M127 170 C 115 162 113 152 118 147 C 122 144 126 146 127 150 C 128 146 132 144 136 147 C 141 152 139 162 127 170 Z"
              fill="#f43f5e"
              filter={`url(#${uid}-glow)`}
            />
            {/* Center aorta highlight */}
            <circle cx="127" cy="153" r="2.5" fill="#ffffff" />
          </g>

          {/* 4. LIVER (Metabolic Filter) */}
          <g className="holo-organ-liver" opacity={0.88}>
            <path
              d="M93 218 C 95 210 113 206 127 208 C 137 209 141 214 139 220 C 135 228 123 230 115 236 C 105 240 95 236 93 228 Z"
              fill="#fb923c"
              filter={`url(#${uid}-glow)`}
            />
          </g>

          {/* 5. KIDNEYS (Bilateral Renal Nodes) */}
          <g className="holo-organ-kidneys" opacity={0.9}>
            <path d="M103 238 C 97 238 95 246 96 252 C 97 260 103 264 107 262 C 109 260 108 256 107 252 C 106 248 109 244 107 240 Z" fill="#f59e0b" />
            <path d="M137 238 C 143 238 145 246 144 252 C 143 260 137 264 133 262 C 131 260 132 256 133 252 C 134 248 131 244 133 240 Z" fill="#f59e0b" />
          </g>

          {/* Suit Contours & Biometric Mesh */}
          <path d={SUIT_CONTOURS} fill="none" stroke="#67e8f9" strokeOpacity="0.4" strokeWidth="1" strokeLinecap="round" />

          {/* Futuristic Sweeping Laser Scan Line */}
          <line className="holo-scan-laser" x1="0" y1="0" x2="240" y2="0" stroke="#67e8f9" strokeWidth="2.5" opacity="0.85" filter={`url(#${uid}-glow)`} />
        </g>

        {/* --- Interactive HUD Leader Lines & Tags --- */}
        {showTelemetry && (
          <g className="holo-hud-tags" pointerEvents="none">
            {/* Heart Callout (Left) */}
            <path d="M117 154 L70 154 L52 144" fill="none" stroke="#f43f5e" strokeWidth="1" strokeDasharray="3 2" opacity="0.8" />
            <circle cx="52" cy="144" r="2.5" fill="#f43f5e" />
            <rect x="4" y="134" width="46" height="18" rx="4" fill="rgba(15, 23, 42, 0.85)" stroke="#f43f5e" strokeWidth="0.8" />
            <text x="27" y="146" textAnchor="middle" fill="#fecdd3" fontSize="8.5" fontWeight="700">♥ 72 bpm</text>

            {/* Lungs Callout (Right) */}
            <path d="M136 150 L170 150 L188 140" fill="none" stroke="#38bdf8" strokeWidth="1" strokeDasharray="3 2" opacity="0.8" />
            <circle cx="188" cy="140" r="2.5" fill="#38bdf8" />
            <rect x="190" y="130" width="46" height="18" rx="4" fill="rgba(15, 23, 42, 0.85)" stroke="#38bdf8" strokeWidth="0.8" />
            <text x="213" y="142" textAnchor="middle" fill="#bae6fd" fontSize="8.5" fontWeight="700">🫁 98%</text>

            {/* Metabolic / Glucose Callout (Bottom Left) */}
            <path d="M106 248 L68 248 L52 260" fill="none" stroke="#fb923c" strokeWidth="1" strokeDasharray="3 2" opacity="0.8" />
            <circle cx="52" cy="260" r="2.5" fill="#fb923c" />
            <rect x="6" y="252" width="44" height="18" rx="4" fill="rgba(15, 23, 42, 0.85)" stroke="#fb923c" strokeWidth="0.8" />
            <text x="28" y="264" textAnchor="middle" fill="#fed7aa" fontSize="8.5" fontWeight="700">⚡ 84 mg</text>

            {/* Target Reticle on Selected Region */}
            {selected && (
              <g className="holo-target-reticle">
                {selected === 'head' && <circle cx="120" cy="52" r="32" fill="none" stroke="#ffffff" strokeWidth="1.5" strokeDasharray="6 4" />}
                {selected === 'chest' && <rect x="64" y="104" width="112" height="98" rx="12" fill="none" stroke="#ffffff" strokeWidth="1.5" strokeDasharray="6 4" />}
                {selected === 'abdomen' && <rect x="74" y="210" width="92" height="74" rx="10" fill="none" stroke="#ffffff" strokeWidth="1.5" strokeDasharray="6 4" />}
              </g>
            )}
          </g>
        )}
      </svg>
    </div>
  );
}
