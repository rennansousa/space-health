// Activity map and game layer for the Mission tab.
// Card steps come from the server (each first completion is worth 10 XP there, stored in xp_score).
// The daily routine is kept on this device per crew member; vitals and sync tick themselves from
// real data. Nothing here changes a clinical level: XP and badges are motivation only.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IconName } from '../components/ui';
import type { Card, CrewState, Source } from '../types';
import { organOf, sortedCards, tierSt, type OrganId, type St } from './health';

export const XP_PER_STEP = 10;
export const XP_PER_LEVEL = 100;
const RANKS = ['Cadet', 'Explorer', 'Navigator', 'Pilot', 'Commander', 'Legend'];

export type RoutineId = 'exercise' | 'sleep' | 'checkin' | 'vitals' | 'sync';
interface RoutineDef {
  id: RoutineId;
  icon: IconName;
  title: string;
  detail: string;
  auto: boolean;
  source?: Source;
}

export const ROUTINE: RoutineDef[] = [
  {
    id: 'exercise',
    icon: 'dumbbell',
    title: 'Exercise session',
    detail: 'Crews on the space station exercise about two hours a day to slow bone and muscle loss.',
    auto: false,
    source: { label: 'NASA: Counteracting bone and muscle loss in microgravity', url: 'https://www.nasa.gov/missions/station/iss-research/counteracting-bone-and-muscle-loss-in-microgravity/' },
  },
  {
    id: 'sleep',
    icon: 'moon',
    title: 'Sleep period',
    detail: 'NASA recommends eight hours of sleep; in flight crews average about six. Log it when you finish your sleep period.',
    auto: false,
    source: { label: 'NASA Human Research Program: sleep evidence report', url: 'https://humanresearchroadmap.nasa.gov/evidence/reports/sleep.pdf' },
  },
  {
    id: 'checkin',
    icon: 'smile',
    title: 'How do you feel?',
    detail: 'A daily check-in. If something is off, report it in the Health tab: that also completes this step.',
    auto: false,
  },
  { id: 'vitals', icon: 'pulse', title: 'Vital signs received', detail: 'Completes itself when a device sends a reading today.', auto: true },
  { id: 'sync', icon: 'sync', title: 'Synced with Earth', detail: 'Completes itself after a sync today.', auto: true },
];
const MANUAL: RoutineId[] = ['exercise', 'sleep', 'checkin'];

export interface Leaf {
  key: string;
  label: string;
  done: boolean;
  auto: boolean;
  next: boolean;
  icon?: IconName;
  detail?: string;
  source?: Source;
  toggle?: () => void;
}

export interface Branch {
  id: string;
  label: string;
  st: St | 'routine';
  organ: OrganId | null;
  icon: IconName;
  leaves: Leaf[];
  card?: Card;
}

export interface BadgeView {
  id: string;
  icon: IconName;
  title: string;
  hint: string;
  earned: boolean;
}

// ---------- day keys and on-device routine log

type RoutineLog = Record<string, RoutineId[]>; // yyyy-mm-dd -> completed routine items

export function dayKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const isToday = (iso: string | null | undefined) => !!iso && dayKey(new Date(iso)) === dayKey();
const logKey = (user: string) => `sh.routine.${user}`;

function readLog(user: string): RoutineLog {
  try {
    return JSON.parse(localStorage.getItem(logKey(user)) || '{}') as RoutineLog;
  } catch {
    return {};
  }
}
function writeLog(user: string, log: RoutineLog): void {
  try {
    localStorage.setItem(logKey(user), JSON.stringify(log));
  } catch {
    /* private mode or full storage: the map still works for this session */
  }
}

function streakOf(log: RoutineLog): number {
  const complete = (k: string) => MANUAL.every((id) => log[k]?.includes(id));
  const d = new Date();
  if (!complete(dayKey(d))) d.setDate(d.getDate() - 1); // today still open: count up to yesterday
  let n = 0;
  while (complete(dayKey(d))) {
    n += 1;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

// ---------- the hook

export function useMissionGame(state: CrewState) {
  const user = state.astronaut.id;
  const [log, setLog] = useState<RoutineLog>(() => readLog(user));
  const [bonus, setBonus] = useState(0); // optimistic XP until the server's xp catches up
  const awarded = useRef(new Set<string>());
  const serverXp = state.astronaut.xp ?? 0;

  useEffect(() => setLog(readLog(user)), [user]);
  useEffect(() => setBonus(0), [serverXp]);

  const today = dayKey();
  const todayLog = useMemo(() => log[today] ?? [], [log, today]);

  // auto items: record them for today when the data shows them
  const autoDone: Record<RoutineId, boolean> = {
    exercise: false,
    sleep: false,
    checkin: (state.symptoms ?? []).some((s) => isToday(s.createdAtUtc)),
    vitals: state.vitals.latest.some((v) => isToday(v.measuredAtUtc)),
    sync: isToday(state.lastSyncUtc),
  };
  const autoKey = (Object.keys(autoDone) as RoutineId[]).filter((k) => autoDone[k]).join(',');
  useEffect(() => {
    const add = (autoKey ? (autoKey.split(',') as RoutineId[]) : []).filter((id) => !todayLog.includes(id));
    if (!add.length) return;
    const next = { ...log, [today]: [...todayLog, ...add] };
    setLog(next);
    writeLog(user, next);
  }, [autoKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleRoutine = useCallback(
    (id: RoutineId) => {
      setLog((prev) => {
        const cur = prev[today] ?? [];
        const next = { ...prev, [today]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] };
        writeLog(user, next);
        return next;
      });
    },
    [today, user],
  );

  const noteStep = useCallback((c: Card, i: number, done: boolean) => {
    const k = `${c.cardId}:${i}`;
    if (done && !c.stepsDone?.[i] && !awarded.current.has(k)) {
      awarded.current.add(k);
      setBonus((b) => b + XP_PER_STEP);
    }
  }, []);

  // ---------- branches
  const cards = sortedCards(state.cards).filter((c) => c.riskTier !== 'ROUTINE');
  let nextAssigned = false;
  const takeNext = (open: boolean) => {
    if (!open || nextAssigned) return false;
    nextAssigned = true;
    return true;
  };

  const branches: Branch[] = cards.map((c) => ({
    id: c.cardId,
    label: c.label,
    st: tierSt(c.riskTier),
    organ: organOf(c),
    icon: 'flask',
    card: c,
    leaves: c.whatToDoNow.map((s, i) => {
      const done = !!c.stepsDone?.[i];
      return { key: `${c.cardId}:${i}`, label: s, done, auto: false, next: takeNext(!done) };
    }),
  }));
  if (!cards.length) {
    branches.push({ id: 'clear', label: 'All clear', st: 'ok', organ: 'coracao', icon: 'check', leaves: [] });
  }
  branches.push({
    id: 'routine',
    label: 'Daily routine',
    st: 'routine',
    organ: null,
    icon: 'clock',
    leaves: ROUTINE.map((r) => {
      const done = todayLog.includes(r.id) || autoDone[r.id];
      return {
        key: r.id,
        label: r.title,
        done,
        auto: r.auto,
        next: takeNext(!done && !r.auto),
        icon: r.icon,
        detail: r.detail,
        source: r.source,
        toggle: r.auto || autoDone[r.id] ? undefined : () => toggleRoutine(r.id),
      };
    }),
  });

  // ---------- score
  const routineXp = Object.values(log).reduce((n, ids) => n + ids.length, 0) * XP_PER_STEP;
  const xp = serverXp + bonus + routineXp;
  const level = Math.floor(xp / XP_PER_LEVEL) + 1;
  const rank = RANKS[Math.min(level - 1, RANKS.length - 1)];
  const intoLevel = xp % XP_PER_LEVEL;
  const streak = streakOf(log);
  const allLeaves = branches.flatMap((b) => b.leaves);
  const todayDone = allLeaves.filter((l) => l.done).length;
  const todayTotal = allLeaves.length;

  const prevLevel = useRef(level);
  const [levelUp, setLevelUp] = useState<string | null>(null);
  useEffect(() => {
    if (level > prevLevel.current) {
      setLevelUp(rank);
      const id = window.setTimeout(() => setLevelUp(null), 3500);
      prevLevel.current = level;
      return () => window.clearTimeout(id);
    }
    prevLevel.current = level;
  }, [level, rank]);

  const anyCardStep = cards.some((c) => c.stepsDone?.some(Boolean));
  const badges: BadgeView[] = [
    { id: 'first', icon: 'star', title: 'First step', hint: 'Complete any step', earned: xp > 0 },
    { id: 'branch', icon: 'check', title: 'Branch complete', hint: 'Finish every step of one guidance card', earned: cards.some((c) => c.whatToDoNow.length > 0 && c.whatToDoNow.every((_, i) => c.stepsDone?.[i])) },
    { id: 'care', icon: 'flask', title: 'On it', hint: 'Act on a guidance card', earned: anyCardStep },
    { id: 'routine', icon: 'clock', title: 'Full routine', hint: 'Complete the whole daily routine today', earned: ROUTINE.every((r) => todayLog.includes(r.id) || autoDone[r.id]) },
    { id: 'streak3', icon: 'flame', title: '3-day streak', hint: 'Exercise, sleep and check-in three days in a row', earned: streak >= 3 },
    { id: 'level3', icon: 'trophy', title: 'Navigator', hint: 'Reach level 3', earned: level >= 3 },
  ];

  return { branches, xp, level, rank, intoLevel, streak, todayDone, todayTotal, badges, levelUp, noteStep };
}

export type MissionGame = ReturnType<typeof useMissionGame>;
