import { useState } from 'react';
import { Badge, Icon, Seg, Sheet } from '../components/ui';
import { fmt, sortedCards, tierSt } from '../lib/health';
import { ago, clock, useLang } from '../lib/i18n';
import type { Card, CrewState, HistoryItem } from '../types';

type Sector = 'act' | 'exam' | 'dev';

export function Mission({ state, onCard, onStep }: { state: CrewState; onCard: (c: Card) => void; onStep: (c: Card, i: number, done: boolean) => void }) {
  const { t, lang } = useLang();
  const [sector, setSector] = useState<Sector>('act');
  const [draw, setDraw] = useState<HistoryItem | null>(null);
  const cards = sortedCards(state.cards).filter((c) => c.riskTier !== 'ROUTINE');
  const draws = [...state.history].reverse(); // oldest → newest

  return (
    <div className="mission">
      <div className="progress-hero">
        <div className="ring" style={{ ['--p' as string]: `${state.progress.pct}%` }}>
          <span>{state.progress.pct}%</span>
        </div>
        <div className="col">
          <b>
            {state.progress.done}/{state.progress.total} {t('stepsDone')}
          </b>
          <span className="muted sm">{state.astronaut.displayName}</span>
        </div>
      </div>

      <Seg
        value={sector}
        onChange={setSector}
        options={[
          { id: 'act', label: t('activities') },
          { id: 'exam', label: t('exams') },
          { id: 'dev', label: t('equipment') },
        ]}
      />

      {sector === 'act' && (
        <ol className="journey">
          {cards.length === 0 && <p className="empty">{t('nothingToDo')}</p>}
          {cards.flatMap((c) =>
            c.whatToDoNow.map((s, i) => {
              const done = !!c.stepsDone?.[i];
              const firstOpen = (c.stepsDone ?? []).findIndex((d) => !d);
              const current = !done && i === (firstOpen < 0 ? -1 : firstOpen);
              return (
                <li key={c.cardId + i} className={`stop${done ? ' done' : ''}${current ? ' current' : ''}`}>
                  <button className="stop-dot" aria-pressed={done} aria-label={s} onClick={() => onStep(c, i, !done)}>
                    {done ? <Icon name="check" size={18} /> : i + 1}
                  </button>
                  <button className="stop-body" onClick={() => onCard(c)}>
                    <b>{s}</b>
                    <span className="muted sm">
                      {c.label} · {current ? t('nextUp') : done ? t('done') : ''}
                    </span>
                  </button>
                </li>
              );
            }),
          )}
        </ol>
      )}

      {sector === 'exam' && (
        <ol className="journey">
          {draws.map((h, i) => {
            const last = i === draws.length - 1;
            return (
              <li key={h.drawId} className={`stop done${last ? ' current' : ''}`}>
                <span className="stop-dot">
                  <Icon name="flask" size={16} />
                </span>
                <button className="stop-body" onClick={() => setDraw(h)}>
                  <span className="row between">
                    <b>{h.label}</b>
                    {h.outOfRange > 0 ? <Badge st="att" small /> : <Badge st="ok" small />}
                  </span>
                  <span className="muted sm">
                    {h.outOfRange}/{h.measurements} · {h.review ?? '—'}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {sector === 'dev' && (
        <div className="devices">
          {state.devices.map((d) => (
            <div key={d.adapter} className={`device dv-${d.status}`}>
              <span className="device-ico">
                <Icon name={d.adapter.includes('EXAM') || d.adapter.includes('CSV') ? 'flask' : 'watch'} size={22} />
              </span>
              <div className="col grow">
                <b>{d.label.split(':')[0].split('(')[0].trim()}</b>
                <span className="muted xs">
                  {t('lastSeen')}: {d.lastSeenUtc ? ago(d.lastSeenUtc, lang) : t('never')}
                </span>
              </div>
              <span className={`pill dv-${d.status}`}>{t(`dev.${d.status}` as 'dev.ACTIVE')}</span>
            </div>
          ))}
        </div>
      )}

      {draw && (
        <Sheet title={`${t('exams')} · ${draw.label}`} onClose={() => setDraw(null)}>
          <span className="muted sm">{clock(draw.createdAtUtc)} · {draw.origin}</span>
          <div className="table-card">
            {(draw.findings ?? []).map((f) => (
              <div className="row" key={f.analyte}>
                <span>{f.label}</span>
                <span className="row gap8">
                  <b>
                    {fmt(f.value)} <small>{f.unit}</small>
                  </b>
                  {f.status !== 'IN_RANGE' && <Badge st={f.riskTier ? tierSt(f.riskTier) : 'att'} small />}
                </span>
              </div>
            ))}
            {!draw.findings?.length && <p className="empty">{t('noRecords')}</p>}
          </div>
        </Sheet>
      )}
    </div>
  );
}
