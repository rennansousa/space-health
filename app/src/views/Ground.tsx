import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Icon, Toast } from '../components/ui';
import { ApiError, apiPost, getCached } from '../lib/api';
import { fmt, tierSt, type St } from '../lib/health';
import { ago, clock, useLang } from '../lib/i18n';
import type { GovernanceItem, GroundState, TriageRow, User } from '../types';

const TRI: Record<string, St> = { RED: 'crit', AMBER: 'att', GREEN: 'ok' };

function pattern(r: TriageRow): { label: string; cls: string } {
  if (r.score === null) return { label: 'No data', cls: 'p-none' };
  if ((r.dropPerDay ?? 0) >= 5) return { label: 'Acute change', cls: 'p-acute' };
  if ((r.trendWatch?.length ?? 0) > 0 || r.reasons.some((x) => x.startsWith('Watch'))) return { label: 'Gradual trend', cls: 'p-trend' };
  if (r.previousScore != null && r.score > r.previousScore) return { label: 'Improving', cls: 'p-up' };
  if (r.previousScore != null && r.score < r.previousScore) return { label: 'Decline', cls: 'p-trend' };
  return { label: 'Stable', cls: 'p-flat' };
}

export function Ground({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const { t, lang } = useLang();
  const [g, setG] = useState<GroundState | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [directive, setDirective] = useState<Record<string, string>>({});
  const lastSig = useRef('');

  const load = useCallback(async () => {
    try {
      const r = await getCached<GroundState>('/api/ground/state');
      const sig = JSON.stringify(r.data);
      if (sig !== lastSig.current) {
        lastSig.current = sig;
        setG(r.data);
      }
      setErr(r.fromCache ? t('offline') : '');
    } catch (e) {
      const ae = e as ApiError;
      if (ae.status === 401) onSignOut();
      else setErr(ae.status === 0 ? t('cantReach') : ae.message);
    }
  }, [onSignOut, t]);

  useEffect(() => {
    load();
    const id = window.setInterval(load, 3000);
    return () => window.clearInterval(id);
  }, [load]);

  async function decide(it: GovernanceItem, decision: 'APPROVED' | 'REJECTED' | 'DIRECTIVE_SENT') {
    try {
      const r = await apiPost<{ deliverAfterUtc: string | null; queuedForBlackout: boolean }>('/api/governance/decide', {
        govId: it.govId,
        decision,
        humanDirective: decision === 'DIRECTIVE_SENT' ? directive[it.govId] : undefined,
      });
      setToast(r.queuedForBlackout ? t('blackout') : `${t('decided')} · ${t('inTransit')}`);
      window.setTimeout(() => setToast(null), 3000);
      load();
    } catch (e) {
      setToast((e as Error).message);
      window.setTimeout(() => setToast(null), 3000);
    }
  }

  if (!g) return <div className="center-screen muted">{err || t('loading')}</div>;

  const queue = g.triage.queue;
  const crew = queue.filter((r) => r.rowType === 'CREW');
  const notices = queue.filter((r) => r.rowType === 'NOTICE');
  const cur = crew.find((r) => r.astronautId === sel) ?? crew[0];
  const items = g.governance.filter((x) => x.astronautId === cur?.astronautId);
  const vit = cur ? g.crewVitals?.[cur.astronautId] : undefined;
  const syms = (g.symptoms ?? []).filter((s) => s.astronautId === cur?.astronautId);
  const counts = { crit: crew.filter((r) => r.tier === 'RED').length, att: crew.filter((r) => r.tier === 'AMBER').length, ok: crew.filter((r) => r.tier === 'GREEN').length };

  return (
    <div className="ground">
      <header className="g-top">
        <div className="brand">
          <img src="./icon.svg" alt="" width={34} height={34} />
          <span>{t('ground')}</span>
        </div>
        <div className="row gap8 wrap">
          <span className={`sync ${g.link.blackout ? 's-black' : 's-on'}`}>
            <Icon name={g.link.blackout ? 'cloudOff' : 'cloudOk'} size={16} />
            {g.link.label} · {g.link.blackout ? t('blackout') : `${g.link.demoDelaySeconds}s`}
          </span>
          {g.recordsInTransit > 0 && <span className="sync s-pend">{g.recordsInTransit} {t('inTransit')}</span>}
          <span className="muted sm">{user.display_name}</span>
          <button className="icon-btn ghost" aria-label={t('signOut')} onClick={onSignOut}>
            <Icon name="exit" />
          </button>
        </div>
      </header>
      {err && <div className="err-bar">{err}</div>}

      <div className="g-grid">
        <section className="g-col">
          <div className="kpis">
            <div className="kpi st-crit"><b>{counts.crit}</b><Badge st="crit" small /></div>
            <div className="kpi st-att"><b>{counts.att}</b><Badge st="att" small /></div>
            <div className="kpi st-ok"><b>{counts.ok}</b><Badge st="ok" small /></div>
          </div>
          {notices.map((n) => (
            <div key={n.rank} className="crit-banner static">
              <Icon name="oct" size={20} />
              <span>
                <b>{n.displayName}</b> · {n.reasons[0]}
              </span>
            </div>
          ))}
          <ol className="tri-list">
            {crew.map((r) => {
              const p = pattern(r);
              const on = r.astronautId === cur?.astronautId;
              return (
                <li key={r.astronautId}>
                  <button className={`tri${on ? ' on' : ''}`} onClick={() => setSel(r.astronautId)} aria-pressed={on}>
                    <span className="rank">{r.rank}</span>
                    <span className="avatar-i">{r.displayName.replace('Crew member ', '').slice(0, 4)}</span>
                    <span className="col grow">
                      <b>
                        {r.displayName}
                        {r.simulated && <span className="tag">SIM</span>}
                      </b>
                      <span className="muted xs">{r.lastDrawLabel} · {ago(r.lastReceivedUtc, lang)}</span>
                    </span>
                    <span className={`pat ${p.cls}`}>{p.label}</span>
                    <span className="score">
                      {r.score === null ? '—' : fmt(r.score)}
                      {r.previousScore != null && r.score != null && r.score !== r.previousScore && (
                        <Icon name={r.score > r.previousScore ? 'up' : 'down'} size={14} />
                      )}
                    </span>
                    <Badge st={TRI[r.tier]} small />
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="muted xs formula">{g.triage.formula}</p>
        </section>

        <section className="g-col detail">
          {!cur && <p className="empty">{t('selectCrew')}</p>}
          {cur && (
            <>
              <div className="row between wrap gap8">
                <h2>{cur.displayName}</h2>
                <Badge st={TRI[cur.tier]} />
              </div>
              <ul className="reasons">
                {cur.reasons.slice(0, 4).map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
              {vit && vit.latest.length > 0 && (
                <div className="vit-grid">
                  {vit.latest.map((v) => (
                    <div key={v.type} className={`vit ${v.status === 'IN_RANGE' ? '' : 'out'}`}>
                      <span className="muted xs">{v.label}</span>
                      <b>
                        {fmt(v.value)} <small>{v.unit}</small>
                      </b>
                    </div>
                  ))}
                </div>
              )}
              {syms.length > 0 && (
                <div className="table-card">
                  <span className="label">{t('symptoms')}</span>
                  {syms.map((s) => (
                    <div className="row" key={s.recordId}>
                      <span>
                        {s.discomfortType} · {t(s.region as 'head') || s.region}
                      </span>
                      <span className="muted sm">
                        {s.intensity} · {clock(s.createdAtUtc)} <span className="tag">{t('reported')}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <h3 className="label">{t('reviewQueue')}</h3>
              {items.length === 0 && <p className="empty">{t('noReview')}</p>}
              {items.map((it) => {
                const pending = it.status === 'PENDING_EARTH_REVIEW';
                return (
                  <article key={it.govId} className="gov">
                    <div className="row between wrap gap8">
                      <b>{it.sourceExam}</b>
                      <span className="row gap8">
                        <Badge st={tierSt(it.riskTier)} small />
                        <span className="pill">{it.status.replace(/_/g, ' ')}</span>
                      </span>
                    </div>
                    <span className="muted xs">
                      AI on board · {it.actingAuthority} · {clock(it.receivedAtUtc)}
                      {it.delivery ? ` · ${it.delivery.replace(/_/g, ' ')}` : ''}
                    </span>
                    <table className="findings">
                      <thead>
                        <tr>
                          <th>{t('finding')}</th>
                          <th>{t('value')}</th>
                          <th>{t('range')}</th>
                          <th>{t('delta')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {it.findings
                          .filter((f) => f.status !== 'IN_RANGE' || f.baselineFlag === 'SHIFTED')
                          .map((f) => (
                            <tr key={f.analyte} className={f.status !== 'IN_RANGE' ? 'out' : ''}>
                              <td>{f.label}</td>
                              <td>
                                {fmt(f.value)} {f.unit}
                              </td>
                              <td>{f.labRange.map((x) => (x === null ? '—' : x)).join('–')}</td>
                              <td>{f.deltaVsBaselinePct === null ? '—' : `${f.deltaVsBaselinePct > 0 ? '+' : ''}${fmt(f.deltaVsBaselinePct)}%`}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                    {it.humanDirective && (
                      <div className="directive">
                        <b>{t('directive')}</b>
                        <span>{it.humanDirective}</span>
                        <span className="xs">{it.decidedBy} · {clock(it.decidedAtUtc)}</span>
                      </div>
                    )}
                    {pending && (
                      <div className="decide">
                        <div className="row gap8 wrap">
                          <button className="btn primary" onClick={() => decide(it, 'APPROVED')}>{t('approve')}</button>
                          <button className="btn danger" onClick={() => decide(it, 'REJECTED')}>{t('reject')}</button>
                        </div>
                        <div className="row gap8">
                          <label className="sr-only" htmlFor={`d-${it.govId}`}>{t('directivePh')}</label>
                          <input id={`d-${it.govId}`} placeholder={t('directivePh')} value={directive[it.govId] ?? ''} onChange={(e) => setDirective({ ...directive, [it.govId]: e.target.value })} />
                          <button className="btn" disabled={!directive[it.govId]?.trim()} onClick={() => decide(it, 'DIRECTIVE_SENT')}>
                            {t('sendDirective')}
                          </button>
                        </div>
                      </div>
                    )}
                    {!pending && it.decidedBy && (
                      <span className="muted xs">
                        {t('decided')}: {it.decidedBy} · {clock(it.decidedAtUtc)}
                      </span>
                    )}
                  </article>
                );
              })}
            </>
          )}
        </section>
      </div>
      <Toast text={toast} />
    </div>
  );
}
