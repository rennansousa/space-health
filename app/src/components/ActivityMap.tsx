import { useEffect, useState } from 'react';
import type { Mood } from '../lib/health';
import { XP_PER_LEVEL, XP_PER_STEP, type Branch, type Leaf, type MissionGame } from '../lib/game';
import type { Card } from '../types';
import { Organ } from './Organ';
import { Icon } from './ui';

// Mind map of today's activities: the crew member in the centre, one branch per guidance card
// plus the daily routine, one leaf per step. Positions are percentages of a square box, so the
// same map scales from a phone to a tablet.

const R_BRANCH = 30;
const R_LEAF = 44;

function polar(r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [50 + r * Math.cos(a), 50 + r * Math.sin(a)];
}

/** Arc segments around a branch node: one per step, filled when done. */
function Segments({ leaves }: { leaves: Leaf[] }) {
  const n = Math.max(leaves.length, 1);
  const r = 30;
  const gap = n > 1 ? 10 : 0;
  return (
    <svg className="mm-seg" viewBox="0 0 68 68" aria-hidden="true">
      {(leaves.length ? leaves : [{ done: true } as Leaf]).map((l, i) => {
        const a0 = -90 + (360 / n) * i + gap / 2;
        const a1 = a0 + 360 / n - gap;
        const [x0, y0] = [34 + r * Math.cos((a0 * Math.PI) / 180), 34 + r * Math.sin((a0 * Math.PI) / 180)];
        const [x1, y1] = [34 + r * Math.cos((a1 * Math.PI) / 180), 34 + r * Math.sin((a1 * Math.PI) / 180)];
        const large = a1 - a0 > 180 ? 1 : 0;
        const d = n === 1 && gap === 0 ? `M34 4 A30 30 0 1 1 33.99 4` : `M${x0} ${y0} A${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
        return <path key={i} d={d} className={l.done ? 'on' : ''} />;
      })}
    </svg>
  );
}

function moodOf(b: Branch): Mood {
  const done = b.leaves.filter((l) => l.done).length;
  if (!b.leaves.length || done === b.leaves.length) return 'celebrate';
  if (b.st === 'crit' || b.st === 'att') return done ? 'happy' : 'worried';
  return done ? 'happy' : 'neutral';
}

export function ActivityMap({
  game,
  onCard,
  onStep,
  name,
}: {
  game: MissionGame;
  onCard: (c: Card) => void;
  onStep: (c: Card, i: number, done: boolean) => void;
  name: string;
}) {
  const { branches } = game;
  const nextBranch = branches.find((b) => b.leaves.some((l) => l.next)) ?? branches[0];
  const [sel, setSel] = useState<string>(nextBranch.id);
  const [focusLeaf, setFocusLeaf] = useState<string | null>(null);
  const [pop, setPop] = useState<{ k: number; text: string } | null>(null);
  const branch = branches.find((b) => b.id === sel) ?? nextBranch;

  useEffect(() => {
    if (!pop) return;
    const id = window.setTimeout(() => setPop(null), 1400);
    return () => window.clearTimeout(id);
  }, [pop]);

  const N = branches.length;
  const start = N === 2 ? 180 : -90; // two branches: left and right, leaves fan outwards
  const angleOf = (i: number) => start + (360 / N) * i;

  function complete(b: Branch, l: Leaf, i: number) {
    const becomesDone = !l.done;
    if (b.card) {
      game.noteStep(b.card, i, becomesDone);
      onStep(b.card, i, becomesDone);
    } else l.toggle?.();
    if (becomesDone) {
      const finishesBranch = b.leaves.every((x) => x.done || x.key === l.key);
      setPop({ k: Date.now(), text: finishesBranch ? `+${XP_PER_STEP} XP · branch complete!` : `+${XP_PER_STEP} XP` });
    }
  }

  return (
    <div className="mm-wrap">
      <div className="mm" role="group" aria-label="Activity map">
        <svg className="mm-lines" viewBox="0 0 100 100" aria-hidden="true">
          {branches.map((b, i) => {
            const a = angleOf(i);
            const [bx, by] = polar(R_BRANCH, a);
            const [cx, cy] = polar(R_BRANCH * 0.5, a + 14);
            const full = b.leaves.every((l) => l.done);
            const fan = Math.min(15, ((360 / N) * 0.8) / Math.max(1, b.leaves.length - 1));
            return (
              <g key={b.id} className={`mm-c c-${b.st}`}>
                <path d={`M50 50 Q${cx} ${cy} ${bx} ${by}`} className={`trunk${full ? ' full' : ''}${b.id === branch.id ? ' sel' : ''}`} />
                {b.leaves.map((l, j) => {
                  const [lx, ly] = polar(R_LEAF, a + (j - (b.leaves.length - 1) / 2) * fan);
                  return <line key={l.key} x1={bx} y1={by} x2={lx} y2={ly} className={`twig${l.done ? ' full' : ''}`} />;
                })}
              </g>
            );
          })}
        </svg>

        <div className="mm-hub" style={{ ['--p' as string]: `${(game.intoLevel / XP_PER_LEVEL) * 100}%` }}>
          <span className="mm-hub-in">
            <small>LEVEL</small>
            <b>{game.level}</b>
            <small className="mm-hub-name">{name}</small>
          </span>
        </div>

        {branches.map((b, i) => {
          const a = angleOf(i);
          const [bx, by] = polar(R_BRANCH, a);
          const below = Math.sin((a * Math.PI) / 180) < 0.35;
          const done = b.leaves.filter((l) => l.done).length;
          const fan = Math.min(15, ((360 / N) * 0.8) / Math.max(1, b.leaves.length - 1));
          const hasNext = b.leaves.some((l) => l.next);
          return (
            <div key={b.id} className={`mm-c c-${b.st}`}>
              <button
                className={`mm-node${b.id === branch.id ? ' sel' : ''}${hasNext ? ' has-next' : ''}`}
                style={{ left: `${bx}%`, top: `${by}%` }}
                onClick={() => {
                  setSel(b.id);
                  setFocusLeaf(null);
                }}
                aria-pressed={b.id === branch.id}
                aria-label={`${b.label}: ${done} of ${b.leaves.length} done`}
              >
                <Segments leaves={b.leaves} />
                <span className="mm-face">{b.organ ? <Organ organ={b.organ} mood={moodOf(b)} size={38} /> : <Icon name={b.icon} size={22} />}</span>
                <span className={`mm-label ${below ? 'below' : 'above'}`}>
                  <b>{b.label}</b>
                  {b.leaves.length > 0 && (
                    <small>
                      {done}/{b.leaves.length}
                    </small>
                  )}
                </span>
              </button>
              {b.leaves.map((l, j) => {
                const [lx, ly] = polar(R_LEAF, a + (j - (b.leaves.length - 1) / 2) * fan);
                return (
                  <button
                    key={l.key}
                    className={`mm-leaf${l.done ? ' done' : ''}${l.next ? ' next' : ''}${l.auto ? ' auto' : ''}${focusLeaf === l.key ? ' focus' : ''}`}
                    style={{ left: `${lx}%`, top: `${ly}%` }}
                    onClick={() => {
                      setSel(b.id);
                      setFocusLeaf(l.key);
                    }}
                    aria-label={`${l.label}${l.done ? ', done' : l.next ? ', next' : ''}`}
                  >
                    {l.done ? <Icon name="check" size={14} stroke={2.6} /> : l.icon ? <Icon name={l.icon} size={13} /> : j + 1}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      <section className={`quest c-${branch.st}`} aria-live="polite">
        <header className="quest-head">
          <span className="quest-face">{branch.organ ? <Organ organ={branch.organ} mood={moodOf(branch)} size={44} /> : <Icon name={branch.icon} size={24} />}</span>
          <div className="col grow">
            <b>{branch.label}</b>
            <span className="muted xs">
              {branch.leaves.length
                ? `${branch.leaves.filter((l) => l.done).length} of ${branch.leaves.length} done · ${XP_PER_STEP} XP each`
                : 'No open guidance. Your organs are cheering.'}
            </span>
          </div>
          {branch.card && (
            <button className="btn sm" onClick={() => onCard(branch.card!)}>
              Open guidance
            </button>
          )}
          {pop && (
            <span key={pop.k} className="xp-pop" role="status">
              {pop.text}
            </span>
          )}
        </header>
        {branch.leaves.length > 0 && (
          <ol className="quest-list">
            {branch.leaves.map((l, i) => (
              <li key={l.key} className={`q${l.done ? ' done' : ''}${l.next ? ' next' : ''}${focusLeaf === l.key ? ' focus' : ''}`}>
                <button
                  className="q-check"
                  aria-pressed={l.done}
                  disabled={!branch.card && !l.toggle}
                  onClick={() => complete(branch, l, i)}
                  aria-label={`${l.done ? 'Mark not done' : 'Mark done'}: ${l.label}`}
                >
                  {l.done ? <Icon name="check" size={18} stroke={2.6} /> : l.icon ? <Icon name={l.icon} size={18} /> : i + 1}
                </button>
                <div className="col grow">
                  <b>{l.label}</b>
                  {l.detail && <span className="muted xs">{l.detail}</span>}
                  {l.source && (
                    <a className="xs" href={l.source.url} target="_blank" rel="noreferrer">
                      Source: {l.source.label}
                    </a>
                  )}
                </div>
                <span className={`xp-chip${l.done ? ' got' : ''}`}>{l.next && !l.done ? 'Next · ' : ''}+{XP_PER_STEP} XP</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

export function PlayerCard({ game }: { game: MissionGame }) {
  return (
    <div className="player">
      <div className="player-ring" style={{ ['--p' as string]: `${(game.intoLevel / XP_PER_LEVEL) * 100}%` }}>
        <span>{game.level}</span>
      </div>
      <div className="col grow">
        <span className="row between">
          <b>{game.rank}</b>
          <span className="muted xs">{game.xp} XP</span>
        </span>
        <span className="xp-bar" role="progressbar" aria-valuemin={0} aria-valuemax={XP_PER_LEVEL} aria-valuenow={game.intoLevel} aria-label="Progress to next level">
          <span style={{ width: `${(game.intoLevel / XP_PER_LEVEL) * 100}%` }} />
        </span>
        <span className="row gap8 player-meta">
          <span className={`streak${game.streak ? ' on' : ''}`}>
            <Icon name="flame" size={15} /> {game.streak}-day streak
          </span>
          <span className="muted xs">
            {game.todayDone}/{game.todayTotal} today · {XP_PER_LEVEL - game.intoLevel} XP to level {game.level + 1}
          </span>
        </span>
      </div>
      {game.levelUp && (
        <span className="levelup" role="status">
          <Icon name="trophy" size={16} /> Level up! You are now {game.levelUp}
        </span>
      )}
    </div>
  );
}

export function Badges({ game }: { game: MissionGame }) {
  return (
    <section className="badges" aria-label="Badges">
      <h3>Badges</h3>
      <ul>
        {game.badges.map((b) => (
          <li key={b.id} className={b.earned ? 'earned' : ''} title={b.hint}>
            <span className="badge-ico">
              <Icon name={b.earned ? b.icon : 'lock'} size={18} />
            </span>
            <b>{b.title}</b>
            <small>{b.earned ? 'Earned' : b.hint}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}
