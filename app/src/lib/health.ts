// Turns the API's CrewState into what the screens show: organs in the race,
// their short opinions, body regions, orientations and the history timeline.
// Nothing here invents a value: every number shown comes from a card, a finding or a vital.

import type { Card, CrewState, Finding, VitalReading } from '../types';
import type { Lang } from './i18n';

export type OrganId = 'coracao' | 'pulmao' | 'cerebro' | 'rins' | 'figado';
export type Mood = 'neutral' | 'happy' | 'celebrate' | 'worried' | 'nodata';
export type St = 'ok' | 'att' | 'crit' | 'none';

export const ORGAN_IDS: OrganId[] = ['coracao', 'pulmao', 'cerebro', 'rins', 'figado'];

const ORGAN_RULES: Record<OrganId, { systems: string[]; analytes: string[]; vitals: string[] }> = {
  coracao: { systems: ['cardiovascular'], analytes: [], vitals: ['HEART_RATE', 'SYSTOLIC_BP', 'DIASTOLIC_BP'] },
  pulmao: { systems: ['respiratory'], analytes: [], vitals: ['SPO2', 'RESP_RATE'] },
  cerebro: { systems: ['neuro'], analytes: [], vitals: [] },
  rins: { systems: [], analytes: ['CREATININE', 'UREA_NITROGEN_BUN', 'BUN_CREATININE_RATIO'], vitals: [] },
  figado: { systems: [], analytes: ['ALT', 'AST', 'BILIRUBIN_TOTAL', 'ALBUMIN', 'GLOBULIN', 'AG_RATIO'], vitals: [] },
};

function belongs(organ: OrganId, analyte: string, system: string): boolean {
  const r = ORGAN_RULES[organ];
  return r.analytes.includes(analyte) || (r.systems.includes(system) && !ORGAN_IDS.some((o) => o !== organ && ORGAN_RULES[o].analytes.includes(analyte)));
}

/** The organ mascot that speaks for a card, or null when no organ owns it (e.g. glucose). */
export function organOf(c: Pick<Card, 'analyte' | 'system'>): OrganId | null {
  return ORGAN_IDS.find((o) => belongs(o, c.analyte, c.system)) ?? null;
}

const TIER_RANK: Record<string, number> = { CRITICAL: 3, ATTENTION: 2, ROUTINE: 1 };
function tierToSt(rank: number): St {
  return rank >= 3 ? 'crit' : rank === 2 ? 'att' : rank === 1 ? 'ok' : 'none';
}

function outOfRangeCount(findings: Finding[] | undefined, organ: OrganId): number | null {
  if (!findings) return null;
  const mine = findings.filter((f) => belongs(organ, f.analyte, f.system));
  if (!mine.length) return null;
  return mine.filter((f) => f.status !== 'IN_RANGE').length;
}

export interface OrganView {
  id: OrganId;
  st: St;
  mood: Mood;
  frac: number;
  trend: 'up' | 'down' | 'flat' | null;
  cards: Card[];
  vitals: VitalReading[];
  findings: Finding[];
  headlineValue: string;
  lastAt: string | null;
}

export function organViews(s: CrewState): OrganView[] {
  const latestFindings = s.latestDraw?.findings ?? s.history[0]?.findings ?? [];
  return ORGAN_IDS.map((id) => {
    const cards = s.cards.filter((c) => belongs(id, c.analyte, c.system));
    const vitals = s.vitals.latest.filter((v) => ORGAN_RULES[id].vitals.includes(v.type)).sort((a, b) => ORGAN_RULES[id].vitals.indexOf(a.type) - ORGAN_RULES[id].vitals.indexOf(b.type));
    const findings = latestFindings.filter((f) => belongs(id, f.analyte, f.system));
    let rank = 0;
    cards.forEach((c) => (rank = Math.max(rank, TIER_RANK[c.riskTier] ?? 0)));
    vitals.forEach((v) => (rank = Math.max(rank, v.status === 'IN_RANGE' ? 1 : 2)));
    if (!rank && findings.length) rank = 1;
    const st = tierToSt(rank);

    // evolution between the two latest draws: fewer values out of range = moving forward
    let trend: OrganView['trend'] = null;
    const draws = s.history.filter((h) => h.findings && h.findings.length);
    if (draws.length >= 2) {
      const a = outOfRangeCount(draws[0].findings, id);
      const b = outOfRangeCount(draws[1].findings, id);
      if (a !== null && b !== null) trend = a < b ? 'up' : a > b ? 'down' : 'flat';
    }
    const base = st === 'ok' ? 0.74 : st === 'att' ? 0.44 : st === 'crit' ? 0.16 : 0;
    const frac = st === 'none' ? 0 : Math.min(0.94, Math.max(0.06, base + (trend === 'up' ? 0.1 : trend === 'down' ? -0.1 : 0)));
    const mood: Mood = st === 'none' ? 'nodata' : st === 'ok' ? (trend === 'up' ? 'celebrate' : 'happy') : 'worried';

    const worst = [...cards].sort((x, y) => (TIER_RANK[y.riskTier] ?? 0) - (TIER_RANK[x.riskTier] ?? 0))[0];
    const vital = vitals[0];
    const headlineValue = worst && worst.riskTier !== 'ROUTINE'
      ? `${fmt(worst.value)} ${worst.unit}`
      : vital
        ? `${fmt(vital.value)} ${vital.unit}`
        : findings[0]
          ? `${fmt(findings[0].value)} ${findings[0].unit}`
          : '—';
    const lastAt = vital?.measuredAtUtc ?? (findings.length ? s.latestDraw?.createdAtUtc ?? null : null);
    return { id, st, mood, frac, trend, cards, vitals, findings, headlineValue, lastAt };
  });
}

export function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

const VITAL_SHORT: Record<string, string> = {
  HEART_RATE: 'heart rate',
  SPO2: 'oxygen',
  RESP_RATE: 'breathing rate',
  SYSTOLIC_BP: 'blood pressure',
  DIASTOLIC_BP: 'blood pressure',
};

/** The short line an organ says when tapped. Always built from a real record. */
export function opinion(o: OrganView, _lang?: Lang): string {
  const worst = [...o.cards].sort((x, y) => (TIER_RANK[y.riskTier] ?? 0) - (TIER_RANK[x.riskTier] ?? 0))[0];
  if (o.st === 'none') return "No data for me yet. I'll wait at the start.";
  if (o.st === 'crit' && worst) {
    return `${worst.label} needs action now. Call your medical officer.`;
  }
  if (o.st === 'att' && worst) {
    const dir = worst.status === 'LOW' ? 'below' : 'above';
    return `${worst.label} is ${dir} your normal: ${fmt(worst.value)} ${worst.unit}. Let's keep an eye on it.`;
  }
  const v = o.vitals.find((x) => x.status !== 'IN_RANGE') ?? o.vitals[0];
  if (v) {
    const name = VITAL_SHORT[v.type] ?? v.label;
    if (v.status !== 'IN_RANGE') return `My ${name} is out of range: ${fmt(v.value)} ${v.unit}.`;
    if (o.id === 'coracao') return `${fmt(v.value)} ${v.unit} right now. Right on rhythm!`;
    if (o.id === 'pulmao') return `${fmt(v.value)}${v.unit} oxygen. Breathing easy!`;
    return `My ${name}: ${fmt(v.value)} ${v.unit}, in range.`;
  }
  if (o.trend === 'up') return 'Better than the last exam!';
  return 'Nothing off for me in the last exam.';
}

/** How long a bubble stays: enough to read it, not longer. */
export function readMs(text: string): number {
  return Math.min(8000, Math.max(3500, 1800 + text.length * 55));
}

// ---------- body regions

export type RegionId = 'head' | 'chest' | 'abdomen' | 'armL' | 'armR' | 'legL' | 'legR';
export const REGION_IDS: RegionId[] = ['head', 'chest', 'abdomen', 'armL', 'armR', 'legL', 'legR'];
const REGION_SYSTEMS: Record<RegionId, string[]> = {
  head: ['neuro'],
  chest: ['cardiovascular', 'respiratory'],
  abdomen: ['metabolic'],
  armL: ['musculoskeletal'],
  armR: ['musculoskeletal'],
  legL: ['musculoskeletal'],
  legR: ['musculoskeletal'],
};
export const REGION_ORGANS: Record<RegionId, OrganId[]> = {
  head: ['cerebro'],
  chest: ['coracao', 'pulmao'],
  abdomen: ['rins', 'figado'],
  armL: [],
  armR: [],
  legL: [],
  legR: [],
};

export interface RegionView {
  id: RegionId;
  st: St;
  cards: Card[];
  vitals: VitalReading[];
  symptoms: NonNullable<CrewState['symptoms']>;
}

export function regionViews(s: CrewState, organs: OrganView[]): RegionView[] {
  return REGION_IDS.map((id) => {
    const cards = s.cards.filter((c) => REGION_SYSTEMS[id].includes(c.system));
    const vitals = organs.filter((o) => REGION_ORGANS[id].includes(o.id)).flatMap((o) => o.vitals);
    let rank = 0;
    cards.forEach((c) => (rank = Math.max(rank, TIER_RANK[c.riskTier] ?? 0)));
    vitals.forEach((v) => (rank = Math.max(rank, v.status === 'IN_RANGE' ? 1 : 2)));
    const sys = s.systems as Record<string, string | null>;
    REGION_SYSTEMS[id].forEach((k) => (rank = Math.max(rank, TIER_RANK[sys[k] ?? ''] ?? 0)));
    const symptoms = (s.symptoms ?? []).filter((x) => x.region === id);
    return { id, st: tierToSt(rank), cards, vitals, symptoms };
  });
}

// ---------- orientations (the cards) and history

export const tierSt = (t: string): St => (t === 'CRITICAL' ? 'crit' : t === 'ATTENTION' ? 'att' : 'ok');

export function sortedCards(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => (TIER_RANK[b.riskTier] ?? 0) - (TIER_RANK[a.riskTier] ?? 0));
}

export type HistKind = 'exam' | 'symptom' | 'decision' | 'action' | 'signal';
export interface HistItem {
  id: string;
  kind: HistKind;
  at: string | null;
  title: string;
  detail: string;
  st?: St;
  pending?: boolean;
}

export function timeline(s: CrewState, _lang?: Lang): HistItem[] {
  const out: HistItem[] = [];
  s.history.forEach((h) =>
    out.push({
      id: 'draw-' + h.drawId,
      kind: 'exam',
      at: h.createdAtUtc ?? null,
      title: 'Exam ' + h.label,
      detail: `${h.measurements} values · ${h.outOfRange} out of range${h.review ? ' · ' + h.review : ''}`,
      st: h.outOfRange ? 'att' : 'ok',
      pending: h.syncStatus === 'LOCAL_ONLY_OFFLINE',
    }),
  );
  (s.symptoms ?? []).forEach((x) =>
    out.push({
      id: 'sym-' + x.recordId,
      kind: 'symptom',
      at: x.createdAtUtc,
      title: `${x.discomfortType}`,
      detail: `${x.intensity} · ${x.onset} · ${x.duration}${x.description ? ' · ' + x.description : ''}`,
      pending: x.syncStatus === 'LOCAL_ONLY_OFFLINE',
    }),
  );
  const seen = new Set<string>();
  s.cards.forEach((c) => {
    const r = c.review;
    if (r && r.decidedAtUtc && !seen.has(r.govId || '')) {
      seen.add(r.govId || '');
      out.push({ id: 'dec-' + (r.govId || c.cardId), kind: 'decision', at: r.decidedAtUtc, title: r.label, detail: [r.decidedBy, r.humanDirective].filter(Boolean).join(' · ') });
    }
    (c.stepsDone ?? []).forEach((done, i) => {
      if (done) out.push({ id: `act-${c.cardId}-${i}`, kind: 'action', at: null, title: c.whatToDoNow[i] ?? '', detail: c.label });
    });
  });
  s.vitals.latest.forEach((v) =>
    out.push({ id: 'vit-' + v.type, kind: 'signal', at: v.measuredAtUtc, title: `${v.label}: ${fmt(v.value)} ${v.unit}`, detail: v.adapter, st: v.status === 'IN_RANGE' ? 'ok' : 'att' }),
  );
  return out.sort((a, b) => (b.at ? Date.parse(b.at) : 0) - (a.at ? Date.parse(a.at) : 0));
}
