import { useId, useRef, useState, type PointerEvent } from 'react';
import type { RegionId, St } from '../lib/health';

// Front view, viewer's left = the body's right side.
const ARM_R = 'M66 108 C 52 112 44 124 42 142 L 36 206 C 34 232 32 254 30 274 C 28 286 30 298 34 304 C 40 308 46 304 46 296 L 48 276 C 52 254 56 232 58 210 L 62 160 Z';
const LEG_R = 'M70 284 C 86 294 106 298 118 294 L 116 352 C 115 392 112 430 110 470 C 110 480 104 486 94 486 L 84 486 C 80 482 82 476 86 472 L 88 470 C 86 430 80 392 76 352 C 72 326 68 304 70 284 Z';
function mirror(d: string): string {
  // mirror every x around 120 (x values are the 1st, 3rd, 5th... numbers of each coordinate pair)
  let i = 0;
  return d.replace(/-?\d+(\.\d+)?/g, (n) => (i++ % 2 === 0 ? String(240 - Number(n)) : n));
}
export const REGION_PATHS: Record<RegionId, string> = {
  head: 'M120 18 C 138 18 148 34 148 52 C 148 70 136 84 120 84 C 104 84 92 70 92 52 C 92 34 102 18 120 18 Z M108 82 L132 82 L134 98 L106 98 Z',
  chest: 'M106 96 C 94 98 80 100 70 106 C 60 112 56 124 57 140 L 60 172 C 62 188 66 198 72 204 L 168 204 C 174 198 178 188 180 172 L 183 140 C 184 124 180 112 170 106 C 160 100 146 98 134 96 Z',
  abdomen: 'M72 208 L168 208 C 167 230 166 252 170 278 C 150 292 90 292 70 278 C 74 252 73 230 72 208 Z',
  armR: ARM_R,
  armL: mirror(ARM_R),
  legR: LEG_R,
  legL: mirror(LEG_R),
};

const FILL: Record<St, [string, string, string]> = {
  ok: ['#B7F0CB', '#3FBF74', '#1E8A4C'],
  att: ['#FFE9A6', '#F2B200', '#B07F00'],
  crit: ['#FFC2BC', '#E5372B', '#A3160C'],
  none: ['#E4E9F0', '#AAB4C3', '#7C8798'],
};

const CONTOURS =
  'M84 108 C 98 112 110 110 118 104 M122 104 C 130 110 142 112 156 108 M76 140 C 92 154 108 154 118 146 M122 146 C 132 154 148 154 164 140 M120 104 L120 200 M100 222 L140 222 M98 242 L142 242 M99 262 L141 262 M120 210 L120 284 M90 384 C 96 389 102 389 106 384 M134 384 C 138 389 144 389 150 384 M50 200 C 54 204 58 204 60 200 M190 200 C 186 204 182 204 180 200';

export function BodyAvatar({ status, selected, onSelect, label }: { status: Record<RegionId, St>; selected: RegionId | null; onSelect: (r: RegionId) => void; label: string }) {
  const uid = useId().replace(/:/g, '');
  const stage = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function move(e: PointerEvent) {
    if (reduce || !stage.current) return;
    const r = stage.current.getBoundingClientRect();
    setTilt({ x: ((e.clientX - r.left) / r.width - 0.5) * 16, y: -((e.clientY - r.top) / r.height - 0.5) * 8 });
  }

  const ids = Object.keys(REGION_PATHS) as RegionId[];
  return (
    <div ref={stage} className="body-stage" onPointerMove={move} onPointerLeave={() => setTilt({ x: 0, y: 0 })}>
      <svg
        viewBox="0 0 240 500"
        role="img"
        aria-label={label}
        className="body-svg"
        style={{ transform: `perspective(900px) rotateY(${tilt.x}deg) rotateX(${tilt.y}deg)` }}
      >
        <defs>
          {(Object.keys(FILL) as St[]).map((s) => (
            <linearGradient key={s} id={`${uid}-g-${s}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor={FILL[s][0]} />
              <stop offset="0.55" stopColor={FILL[s][1]} />
              <stop offset="1" stopColor={FILL[s][2]} />
            </linearGradient>
          ))}
          <radialGradient id={`${uid}-sheen`} cx="0.32" cy="0.22" r="0.75">
            <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
            <stop offset="0.45" stopColor="#fff" stopOpacity="0.08" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`${uid}-floor`} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#5C8DFF" stopOpacity="0.45" />
            <stop offset="1" stopColor="#5C8DFF" stopOpacity="0" />
          </radialGradient>
          <clipPath id={`${uid}-clip`}>
            {ids.map((id) => (
              <path key={id} d={REGION_PATHS[id]} />
            ))}
          </clipPath>
        </defs>
        <ellipse cx="120" cy="488" rx="96" ry="14" fill={`url(#${uid}-floor)`} />
        <ellipse cx="120" cy="488" rx="78" ry="10" fill="none" stroke="#5C8DFF" strokeOpacity="0.5" />
        <ellipse cx="120" cy="488" rx="104" ry="16" fill="none" stroke="#5C8DFF" strokeOpacity="0.22" strokeDasharray="3 6" />
        {ids.map((id) => (
          <path
            key={id}
            d={REGION_PATHS[id]}
            fill={`url(#${uid}-g-${status[id]})`}
            stroke={selected === id ? '#FFFFFF' : FILL[status[id]][2]}
            strokeWidth={selected === id ? 3 : 1.4}
            className={`region${selected === id ? ' sel' : ''}`}
            onClick={() => onSelect(id)}
          />
        ))}
        <g clipPath={`url(#${uid}-clip)`} pointerEvents="none">
          <rect x="0" y="0" width="240" height="500" fill={`url(#${uid}-sheen)`} />
          {/* organs seen through the body */}
          <path d="M101 40 C 101 30 112 26 120 30 C 128 26 140 30 139 40 C 142 48 136 56 128 56 C 124 60 116 60 112 56 C 104 56 98 48 101 40 Z" fill="#A57BFF" opacity="0.85" />
          <path d="M116 128 C 104 124 92 136 92 156 C 92 170 98 178 106 176 C 114 174 116 166 116 156 Z M124 128 C 136 124 148 136 148 156 C 148 170 142 178 134 176 C 126 174 124 166 124 156 Z" fill="#4AA6FF" opacity="0.75" />
          <path d="M126 176 C 112 168 110 156 116 151 C 120 148 125 150 126 154 C 127 150 132 148 136 151 C 142 156 140 168 126 176 Z" fill="#F0476B" />
          <path d="M92 220 C 94 212 112 208 128 210 C 138 211 142 216 140 222 C 136 230 124 232 114 238 C 104 242 94 238 92 230 Z" fill="#B2583C" opacity="0.9" />
          <path d="M104 238 C 98 238 96 246 97 252 C 98 260 104 264 108 262 C 110 260 109 256 108 252 C 107 248 110 244 108 240 Z M136 238 C 142 238 144 246 143 252 C 142 260 136 264 132 262 C 130 260 131 256 132 252 C 133 248 130 244 132 240 Z" fill="#F08A3E" />
          <path d={CONTOURS} fill="none" stroke="#fff" strokeOpacity="0.6" strokeWidth="1.1" strokeLinecap="round" />
          <rect className="scan" x="0" y="0" width="240" height="3" fill="#BFF8F2" opacity="0.7" />
        </g>
      </svg>
    </div>
  );
}
