import type { Mood, OrganId } from '../lib/health';

const PAL: Record<OrganId | 'none', { base: string; shade: string; limb: string }> = {
  coracao: { base: '#F0476B', shade: '#B82A4C', limb: '#8E1F3B' },
  pulmao: { base: '#4AA6FF', shade: '#2273C9', limb: '#1B5A9E' },
  cerebro: { base: '#A57BFF', shade: '#7650D6', limb: '#5A3AA8' },
  rins: { base: '#F08A3E', shade: '#BF5E1B', limb: '#8E4413' },
  figado: { base: '#B2583C', shade: '#7E3824', limb: '#5E281A' },
  none: { base: '#CBD2DC', shade: '#A3ADBB', limb: '#7C8798' },
};
export const ORGAN_COLOR: Record<OrganId, string> = {
  coracao: PAL.coracao.base, pulmao: PAL.pulmao.base, cerebro: PAL.cerebro.base, rins: PAL.rins.base, figado: PAL.figado.base,
};

type P = [number, number];
const SH: Record<OrganId, { body: string; detail: string; dw: number; faces: [number, number, number][]; hl: number[]; arms: P[]; legs: P[] }> = {
  coracao: { body: 'M60 98 C 22 74, 12 50, 26 33 C 38 19, 55 23, 60 38 C 65 23, 82 19, 94 33 C 108 50, 98 74, 60 98 Z', detail: 'M54 31 C 51 20, 57 12, 67 12 C 73 12, 77 16, 78 21 M47 29 C 45 22, 46 17, 49 14', dw: 6, faces: [[60, 58, 1]], hl: [38, 40, 9, 5.5, -38], arms: [[22, 58], [98, 58]], legs: [[53, 90], [67, 90]] },
  pulmao: { body: 'M56 32 C 40 28, 22 46, 22 72 C 22 90, 34 98, 46 93 C 54 90, 56 81, 56 70 Z M64 32 C 80 28, 98 46, 98 72 C 98 90, 86 98, 74 93 C 66 90, 64 81, 64 70 Z', detail: 'M60 8 L60 32 M60 32 L52 41 M60 32 L68 41 M56 14 L64 14 M56 20 L64 20', dw: 5, faces: [[40, 66, 0.78], [80, 66, 0.78]], hl: [33, 50, 5.5, 9, 22], arms: [[23, 70], [97, 70]], legs: [[44, 94], [76, 94]] },
  cerebro: { body: 'M30 70 C 16 66, 15 45, 30 40 C 30 25, 48 19, 59 28 C 67 17, 89 21, 91 38 C 106 43, 105 65, 92 70 C 90 83, 74 87, 66 81 C 57 89, 38 85, 30 70 Z', detail: 'M37 41 C 43 35, 50 43, 56 37 M64 33 C 70 29, 76 37, 84 33 M60 28 C 58 35, 62 40, 60 46 M86 49 C 90 53, 95 53, 97 50 M23 51 C 27 55, 31 55, 33 51', dw: 2.6, faces: [[60, 62, 1]], hl: [42, 34, 8, 4.5, -18], arms: [[20, 62], [100, 62]], legs: [[52, 84], [68, 84]] },
  rins: { body: 'M44 30 C 28 30, 22 48, 24 62 C 26 78, 36 90, 46 88 C 54 86, 54 76, 50 66 C 47 58, 50 52, 54 46 C 58 38, 54 30, 44 30 Z M76 30 C 92 30, 98 48, 96 62 C 94 78, 84 90, 74 88 C 66 86, 66 76, 70 66 C 73 58, 70 52, 66 46 C 62 38, 66 30, 76 30 Z', detail: 'M50 60 C 47 62, 47 66, 50 68 M70 60 C 73 62, 73 66, 70 68', dw: 2.6, faces: [[38, 56, 0.72], [82, 56, 0.72]], hl: [35, 38, 6, 3.5, -30], arms: [[25, 62], [95, 62]], legs: [[42, 87], [78, 87]] },
  figado: { body: 'M18 52 C 20 35, 50 28, 77 30 C 95 31, 104 39, 102 49 C 100 61, 85 67, 71 77 C 59 85, 46 89, 35 83 C 22 76, 16 64, 18 52 Z', detail: 'M74 33 C 70 46, 67 60, 64 79', dw: 2.6, faces: [[46, 56, 1]], hl: [36, 40, 10, 4.5, -12], arms: [[19, 58], [101, 50]], legs: [[42, 85], [60, 81]] },
};

const r1 = (n: number) => Math.round(n * 10) / 10;
const circ = (x: number, y: number, r: number) => `M${r1(x - r)} ${r1(y)} a${r1(r)} ${r1(r)} 0 1 0 ${r1(2 * r)} 0 a${r1(r)} ${r1(r)} 0 1 0 ${r1(-2 * r)} 0 `;

function parts(organ: OrganId, mood: Mood) {
  const sh = SH[organ];
  let whites = '', pupils = '', glints = '', lines = '', brows = '', mouth = '', cheeks = '';
  for (const [cx, cy, s] of sh.faces) {
    const ey = cy - 2 * s;
    const exs = [cx - 9 * s, cx + 9 * s];
    if (mood === 'celebrate') exs.forEach((ex) => (lines += `M${r1(ex - 4 * s)} ${r1(ey + 1.5 * s)} Q${r1(ex)} ${r1(ey - 5 * s)} ${r1(ex + 4 * s)} ${r1(ey + 1.5 * s)} `));
    else if (mood === 'nodata') exs.forEach((ex) => (lines += `M${r1(ex - 4 * s)} ${r1(ey)} Q${r1(ex)} ${r1(ey + 3.5 * s)} ${r1(ex + 4 * s)} ${r1(ey)} `));
    else {
      const dy = mood === 'worried' ? -1.4 * s : 0.6 * s;
      exs.forEach((ex) => {
        whites += circ(ex, ey, 6.2 * s);
        pupils += circ(ex + 0.6 * s, ey + dy, 3.2 * s);
        glints += circ(ex - 0.6 * s, ey + dy - 1.2 * s, 1.1 * s);
      });
    }
    if (mood === 'worried') {
      brows += `M${r1(exs[0] - 5 * s)} ${r1(ey - 9 * s)} L${r1(exs[0] + 4 * s)} ${r1(ey - 12 * s)} M${r1(exs[1] - 4 * s)} ${r1(ey - 12 * s)} L${r1(exs[1] + 5 * s)} ${r1(ey - 9 * s)} `;
    }
    if (mood === 'happy' || mood === 'celebrate') cheeks += circ(cx - 13 * s, cy + 6 * s, 3.2 * s) + circ(cx + 13 * s, cy + 6 * s, 3.2 * s);
    const m = (a: number, b: number, c: number) => `M${r1(cx - a * s)} ${r1(cy + b * s)} Q${r1(cx)} ${r1(cy + c * s)} ${r1(cx + a * s)} ${r1(cy + b * s)}`;
    mouth +=
      (mood === 'happy' ? m(6, 8, 15) : mood === 'celebrate' ? m(7, 7, 20) + ' Z' : mood === 'worried' ? m(5, 13, 8.5) : mood === 'nodata' ? `M${r1(cx - 4 * s)} ${r1(cy + 11 * s)} L${r1(cx + 4 * s)} ${r1(cy + 11 * s)}` : m(5, 10, 12.5)) + ' ';
  }
  let arms = '', hands = '';
  sh.arms.forEach(([x, y], k) => {
    const d = k === 0 ? -1 : 1;
    let c: P, e: P;
    if (mood === 'celebrate') { c = [x + d * 10, y - 6]; e = [x + d * 12, y - 21]; }
    else if (mood === 'happy' && k === 1) { c = [x + 10, y - 4]; e = [x + 13, y - 17]; }
    else if (mood === 'worried') { c = [x + d * 8, y + 9]; e = [x + d * 3, y + 16]; }
    else if (mood === 'nodata') { c = [x + d * 4, y + 9]; e = [x + d * 5, y + 19]; }
    else { c = [x + d * 8, y + 6]; e = [x + d * 10, y + 16]; }
    arms += `M${x} ${y} Q${c[0]} ${c[1]} ${e[0]} ${e[1]} `;
    hands += circ(e[0], e[1], 3.8);
  });
  let legs = '', feet = '';
  sh.legs.forEach(([x, y], k) => {
    const d = k === 0 ? -1 : 1;
    const ex = x + d * 2;
    legs += `M${x} ${y} L${ex} 108 `;
    feet += `M${ex + d * 2.5 - 6} 110 a6 3.2 0 1 0 12 0 a6 3.2 0 1 0 -12 0 `;
  });
  return { whites, pupils, glints, lines, brows, mouth, cheeks, arms, hands, legs, feet };
}

export function Organ({ organ, mood = 'happy', size = 64, label }: { organ: OrganId; mood?: Mood; size?: number; label?: string }) {
  const c = mood === 'nodata' ? PAL.none : PAL[organ];
  const sh = SH[organ];
  const p = parts(organ, mood);
  const [hx, hy, hrx, hry, hrot] = sh.hl;
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} style={{ display: 'block', overflow: 'visible' }}>
      <ellipse cx="60" cy="114" rx="26" ry="3.5" fill="#0D1B2E" opacity="0.12" />
      <g transform={mood === 'celebrate' ? 'translate(0 -3)' : undefined}>
        <path d={p.legs} fill="none" stroke={c.limb} strokeWidth="4.2" strokeLinecap="round" />
        <path d={p.feet} fill={c.limb} />
        <path d={p.arms} fill="none" stroke={c.limb} strokeWidth="4.2" strokeLinecap="round" />
        <path d={p.hands} fill={c.limb} />
        <path d={sh.body} fill={c.shade} transform="translate(2.5 3.5)" />
        <path d={sh.body} fill={c.base} stroke={c.shade} strokeWidth="1.6" strokeLinejoin="round" />
        <path d={sh.detail} fill="none" stroke={c.shade} strokeWidth={sh.dw} strokeLinecap="round" />
        <ellipse cx={hx} cy={hy} rx={hrx} ry={hry} transform={`rotate(${hrot} ${hx} ${hy})`} fill="#fff" opacity="0.42" />
        {p.cheeks && <path d={p.cheeks} fill="#FF7A9A" opacity="0.45" />}
        {p.whites && <path d={p.whites} fill="#fff" stroke="#0D1B2E" strokeWidth="1.2" />}
        {p.pupils && <path d={p.pupils} fill="#0D1B2E" />}
        {p.glints && <path d={p.glints} fill="#fff" />}
        {p.lines && <path d={p.lines} fill="none" stroke="#0D1B2E" strokeWidth="2.2" strokeLinecap="round" />}
        {p.brows && <path d={p.brows} fill="none" stroke="#0D1B2E" strokeWidth="2" strokeLinecap="round" />}
        <path d={p.mouth} fill={mood === 'celebrate' ? '#5B1426' : 'none'} stroke="#0D1B2E" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}
