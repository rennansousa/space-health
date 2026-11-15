import { useCallback, useEffect, useMemo, useState } from 'react';
import { BodyView } from '../components/BodyView';
import { Badge, Icon, Orb, Toast } from '../components/ui';
import { ApiError, apiPost, flushOutbox, getCached, outboxCount, postOrQueue } from '../lib/api';
import { organViews, regionViews, sortedCards, tierSt, type OrganId, type RegionId, type St } from '../lib/health';
import { ago, useLang } from '../lib/i18n';
import type { Card, CrewState, User } from '../types';
import { Companion } from './Companion';
import { Mission } from './Mission';
import { BodySheet, CardSheet, GuidanceSheet, OrganSheet, SymptomSheet } from './Panels';
import { Race } from './Race';

type Overlay =
  | { k: 'organ'; id: OrganId }
  | { k: 'guidance' }
  | { k: 'card'; id: string; from?: 'guidance' }
  | { k: 'body'; region?: RegionId }
  | { k: 'symptom'; region: RegionId }
  | null;

function useAcks(userId: string) {
  const key = `sh.ack.${userId}`;
  const [acked, setAcked] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) || '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const ack = (id: string) =>
    setAcked((s) => {
      const n = new Set(s).add(id);
      localStorage.setItem(key, JSON.stringify([...n]));
      return n;
    });
  return { acked, ack };
}

export function Crew({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const { t, lang } = useLang();
  const [state, setState] = useState<CrewState | null>(null);
  const [cache, setCache] = useState(false);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<'health' | 'mission'>('health');
  const [ov, setOv] = useState<Overlay>(null);
  const [chat, setChat] = useState<{ ctx: Card | null } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [queued, setQueued] = useState(outboxCount());
  const [sideSel, setSideSel] = useState<RegionId | null>(null);
  const { acked, ack } = useAcks(user.user_id);

  const flash = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast((x) => (x === m ? null : x)), 3200);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await getCached<CrewState>('/api/crew/state');
      setState(r.data);
      setCache(r.fromCache);
      setErr('');
      if (!r.fromCache && outboxCount() > 0) {
        await flushOutbox();
      }
      setQueued(outboxCount());
    } catch (e) {
      const ae = e as ApiError;
      if (ae.status === 401) onSignOut();
      else setErr(ae.status === 0 ? t('cantReach') : ae.message);
    }
  }, [onSignOut, t]);

  useEffect(() => {
    load();
    const id = window.setInterval(() => document.visibilityState === 'visible' && load(), 3000);
    return () => window.clearInterval(id);
  }, [load]);

  const organs = useMemo(() => (state ? organViews(state) : []), [state]);
  const regions = useMemo(() => (state ? regionViews(state, organs) : []), [state, organs]);

  if (!state) {
    return (
      <div className="center-screen">
        {err ? (
          <div className="col gap10 center">
            <p>{err}</p>
            <button className="btn" onClick={load}>{t('retry')}</button>
            <button className="btn ghost" onClick={onSignOut}>{t('signOut')}</button>
          </div>
        ) : (
          <span className="muted">{t('loading')}</span>
        )}
      </div>
    );
  }

  const critical = state.cards.filter((c) => c.riskTier === 'CRITICAL');
  const fresh = state.cards.filter((c) => c.riskTier !== 'ROUTINE' && !acked.has(c.cardId));
  const directive = state.cards.find((c) => c.review?.humanDirective);
  const card = ov?.k === 'card' ? state.cards.find((c) => c.cardId === ov.id) : undefined;
  const waiting = state.pendingUploadRecords + queued;

  async function step(c: Card, i: number, done: boolean) {
    setState((s) => (s ? { ...s, cards: s.cards.map((x) => (x.cardId === c.cardId ? { ...x, stepsDone: (x.stepsDone ?? []).map((d, k) => (k === i ? done : d)) } : x)) } : s));
    const r = await postOrQueue('/api/cards/step', { cardId: c.cardId, stepIndex: i, done });
    if (!r.sent) setQueued(outboxCount());
  }

  async function sync() {
    try {
      const r = await apiPost<{ demoDelaySeconds: number }>('/api/sync/downlink', {});
      flash(`${t('syncSent')} ${r.demoDelaySeconds}s`);
      load();
    } catch (e) {
      const ae = e as ApiError;
      flash(ae.code === 'NO_LINK' ? t('syncNoLink') : ae.status === 0 ? t('cantReach') : ae.message);
    }
  }

  const organSt = Object.fromEntries(organs.map((o) => [o.id, o.st])) as Record<OrganId, St>;
  const next = sortedCards(fresh)[0];
  function regionLine(r: RegionId): string {
    const rv = regions.find((x) => x.id === r)!;
    const c = sortedCards(rv.cards)[0];
    if (c) return c.headline;
    if (rv.vitals[0]) return rv.vitals.map((v) => `${v.label} ${Math.round(v.value * 10) / 10} ${v.unit}`).join(' · ');
    if (rv.symptoms[0]) return `${rv.symptoms[0].discomfortType} · ${t('reported')}`;
    return t('nothingHere');
  }
  const sync_st = cache ? 'off' : state.link.blackout ? 'black' : waiting > 0 ? 'pend' : 'on';
  const status: Record<RegionId, St> = Object.fromEntries(regions.map((r) => [r.id, r.st])) as Record<RegionId, St>;

  return (
    <div className={`crew${chat ? ' chatting' : ''}`}>
      <header className="top">
        <div className="brand">
          <img src="./icon.svg" alt="" width={34} height={34} />
          <span>{tab === 'health' ? t('health') : t('mission')}</span>
        </div>
        <button className={`sync s-${sync_st}`} onClick={sync} title={t('syncNow')}>
          <Icon name={sync_st === 'on' ? 'cloudOk' : sync_st === 'pend' ? 'sync' : 'cloudOff'} size={16} />
          <span>
            {sync_st === 'off' ? t('offline') : sync_st === 'black' ? t('blackout') : waiting > 0 ? `${waiting} ${t('waiting')}` : `${t('synced')} · ${ago(state.lastSyncUtc, lang)}`}
          </span>
        </button>
        <div className="row gap8">
          <button className="icon-btn bell" aria-label={`${t('guidance')}: ${fresh.length} ${t('newGuidance')}`} onClick={() => setOv({ k: 'guidance' })}>
            <Icon name="bell" size={22} />
            {fresh.length > 0 && <span className="dot-count">{fresh.length}</span>}
          </button>
          <button className="icon-btn ghost" aria-label={t('signOut')} onClick={onSignOut}>
            <Icon name="exit" />
          </button>
        </div>
      </header>

      {critical.length > 0 && (
        <button className="crit-banner" onClick={() => setOv({ k: 'card', id: critical[0].cardId })}>
          <Icon name="oct" size={22} />
          <span>
            <b>{critical[0].headline}</b>
            <br />
            {critical[0].whatToDoNow[0]}
          </span>
        </button>
      )}
      {directive && !critical.length && (
        <button className="directive-banner" onClick={() => setOv({ k: 'card', id: directive.cardId })}>
          <Icon name="check" size={20} />
          <span>
            <b>{t('directive')}</b> · {directive.review?.humanDirective}
          </span>
        </button>
      )}

      <main className="main">
        {tab === 'health' ? (
          <div className="health-grid">
            <Race organs={organs} critical={critical.length > 0} onOpen={(id) => setOv({ k: 'organ', id })} />
            <aside className="side">
              <div className="side-body">
                <BodyView status={status} organSt={organSt} selected={sideSel} onSelect={(r) => setSideSel(r === sideSel ? null : r)} label={t('bodyTitle')} focus={false} />
              </div>
              {sideSel ? (
                <div className="side-card" key={sideSel}>
                  <div className="row between gap8">
                    <b>{t(sideSel)}</b>
                    <Badge st={status[sideSel]} small />
                  </div>
                  <span className="muted sm clamp2">{regionLine(sideSel)}</span>
                  <div className="row gap8">
                    <button className="btn sm" onClick={() => setOv({ k: 'body', region: sideSel })}>{t('details')}</button>
                    <button className="btn sm primary grow" onClick={() => setOv({ k: 'symptom', region: sideSel })}>
                      <Icon name="plus" size={16} /> {t('reportSymptom')}
                    </button>
                  </div>
                </div>
              ) : (
                next && (
                  <button className="g-row" onClick={() => setOv({ k: 'card', id: next.cardId })}>
                    <Badge st={tierSt(next.riskTier)} small />
                    <b className="grow clamp2">{next.headline}</b>
                    <Icon name="chev" size={16} />
                  </button>
                )
              )}
            </aside>
          </div>
        ) : (
          <Mission state={state} onCard={(c) => setOv({ k: 'card', id: c.cardId })} onStep={step} />
        )}
      </main>

      {tab === 'health' && (
        <button className="fab-body" onClick={() => setOv({ k: 'body' })} aria-label={t('bodyTitle')}>
          <svg viewBox="0 0 240 500" width="26" height="54" aria-hidden="true">
            {regions.map((r) => (
              <path key={r.id} d={REGION_MINI[r.id]} className={`mini st-${r.st}`} />
            ))}
          </svg>
          <span>{t('body')}</span>
        </button>
      )}
      {!chat && (
        <button className="fab-chat" onClick={() => setChat({ ctx: null })} aria-label={t('companion')}>
          <Orb size={42} />
          <span>{t('companion')}</span>
        </button>
      )}

      <nav className="tabs" aria-label="Main">
        <button aria-current={tab === 'health' ? 'page' : undefined} className={tab === 'health' ? 'on' : ''} onClick={() => setTab('health')}>
          <Icon name="pulse" size={22} />
          {t('health')}
        </button>
        <button aria-current={tab === 'mission' ? 'page' : undefined} className={tab === 'mission' ? 'on' : ''} onClick={() => setTab('mission')}>
          <Icon name="route" size={22} />
          {t('mission')}
        </button>
      </nav>

      {ov?.k === 'organ' && (
        <OrganSheet
          o={organs.find((o) => o.id === ov.id)!}
          onClose={() => setOv(null)}
          onCard={(c) => setOv({ k: 'card', id: c.cardId })}
          onAsk={() => {
            const o = organs.find((x) => x.id === ov.id)!;
            setChat({ ctx: sortedCards(o.cards)[0] ?? null });
          }}
        />
      )}
      {ov?.k === 'guidance' && <GuidanceSheet state={state} acked={acked} onClose={() => setOv(null)} onCard={(c) => setOv({ k: 'card', id: c.cardId, from: 'guidance' })} />}
      {ov?.k === 'card' && card && (
        <CardSheet
          c={card}
          acked={acked.has(card.cardId)}
          onAck={() => ack(card.cardId)}
          onBack={ov.from === 'guidance' ? () => setOv({ k: 'guidance' }) : undefined}
          onClose={() => setOv(null)}
          onStep={(i, d) => step(card, i, d)}
          onAsk={() => setChat({ ctx: card })}
        />
      )}
      {ov?.k === 'body' && <BodySheet state={state} organs={organs} initial={ov.region} onClose={() => setOv(null)} onReport={(r) => setOv({ k: 'symptom', region: r })} />}
      {ov?.k === 'symptom' && (
        <SymptomSheet
          region={ov.region}
          onClose={() => setOv(null)}
          onBack={() => setOv({ k: 'body', region: ov.region })}
          onSave={async (b) => {
            try {
              const r = await postOrQueue('/api/symptoms', b);
              flash(r.sent ? t('saved') : t('savedOffline'));
              setQueued(outboxCount());
              setOv({ k: 'body' });
              load();
            } catch (e) {
              flash((e as Error).message);
            }
          }}
        />
      )}
      {chat && <Companion ctx={chat.ctx} offline={cache} onClose={() => setChat(null)} />}
      <Toast text={toast} />
    </div>
  );
}

// tiny silhouette for the floating body button
const REGION_MINI: Record<RegionId, string> = {
  head: 'M120 18 C 138 18 148 34 148 52 C 148 70 136 84 120 84 C 104 84 92 70 92 52 C 92 34 102 18 120 18 Z',
  chest: 'M106 96 C 94 98 80 100 70 106 C 60 112 56 124 57 140 L 60 172 C 62 188 66 198 72 204 L 168 204 C 174 198 178 188 180 172 L 183 140 C 184 124 180 112 170 106 C 160 100 146 98 134 96 Z',
  abdomen: 'M72 208 L168 208 C 167 230 166 252 170 278 C 150 292 90 292 70 278 C 74 252 73 230 72 208 Z',
  armR: 'M66 108 C 52 112 44 124 42 142 L 36 206 C 34 232 32 254 30 274 C 28 286 30 298 34 304 C 40 308 46 304 46 296 L 48 276 C 52 254 56 232 58 210 L 62 160 Z',
  armL: 'M174 108 C 188 112 196 124 198 142 L 204 206 C 206 232 208 254 210 274 C 212 286 210 298 206 304 C 200 308 194 304 194 296 L 192 276 C 188 254 184 232 182 210 L 178 160 Z',
  legR: 'M70 284 C 86 294 106 298 118 294 L 116 352 C 115 392 112 430 110 470 C 110 480 104 486 94 486 L 84 486 C 80 482 82 476 86 472 L 88 470 C 86 430 80 392 76 352 C 72 326 68 304 70 284 Z',
  legL: 'M170 284 C 154 294 134 298 122 294 L 124 352 C 125 392 128 430 130 470 C 130 480 136 486 146 486 L 156 486 C 160 482 158 476 154 472 L 152 470 C 154 430 160 392 164 352 C 168 326 172 304 170 284 Z',
};
