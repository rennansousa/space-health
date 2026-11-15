import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Organ } from '../components/Organ';
import { Icon } from '../components/ui';
import { ApiError, getCached } from '../lib/api';
import { opinion, organViews, readMs } from '../lib/health';
import { useLang } from '../lib/i18n';
import type { CrewState } from '../types';

/** Glanceable view for a smartwatch (Wear OS / watchOS web view or companion). One organ at a time. */
export function Watch({ onSignOut }: { onSignOut: () => void }) {
  const { t, lang } = useLang();
  const [s, setS] = useState<CrewState | null>(null);
  const [off, setOff] = useState(false);
  const [i, setI] = useState(0);
  const [talk, setTalk] = useState<string | null>(null);
  const timer = useRef<number>();

  const load = useCallback(async () => {
    try {
      const r = await getCached<CrewState>('/api/crew/state');
      setS(r.data);
      setOff(r.fromCache);
    } catch (e) {
      if ((e as ApiError).status === 401) onSignOut();
    }
  }, [onSignOut]);
  useEffect(() => {
    load();
    const id = window.setInterval(load, 5000);
    return () => window.clearInterval(id);
  }, [load]);

  const organs = useMemo(() => (s ? organViews(s) : []), [s]);
  if (!s) return <div className="watch"><div className="face muted">…</div></div>;
  const o = organs[i % organs.length];
  const fresh = s.cards.filter((c) => c.riskTier !== 'ROUTINE').length;

  function tap() {
    window.clearTimeout(timer.current);
    const txt = opinion(o, lang);
    setTalk(txt);
    timer.current = window.setTimeout(() => setTalk(null), readMs(txt));
  }
  function go(d: number) {
    setTalk(null);
    setI((x) => (x + d + organs.length) % organs.length);
  }

  return (
    <div className="watch">
      <div className={`face ring-${o.st}`}>
        <div className="w-top">
          <Icon name={off ? 'cloudOff' : 'cloudOk'} size={12} />
          {fresh > 0 && (
            <span className="w-bell">
              <Icon name="bell" size={12} /> {fresh}
            </span>
          )}
        </div>
        {talk ? (
          <button className="w-talk" onClick={() => setTalk(null)} aria-live="polite">
            {talk}
          </button>
        ) : (
          <button className="w-organ" onClick={tap} aria-label={`${t(o.id)}. ${t('tapOrgan')}`}>
            <Organ organ={o.id} mood={o.mood} size={88} />
          </button>
        )}
        <div className="w-name">
          <b>{t(o.id)}</b>
          <span>{o.headlineValue}</span>
        </div>
        <div className="w-nav">
          <button aria-label="Previous" onClick={() => go(-1)}>
            <Icon name="back" size={16} />
          </button>
          <span className="w-dots">
            {organs.map((x, k) => (
              <span key={x.id} className={`wd st-${x.st}${k === i % organs.length ? ' on' : ''}`} />
            ))}
          </span>
          <button aria-label="Next" onClick={() => go(1)}>
            <Icon name="chev" size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
