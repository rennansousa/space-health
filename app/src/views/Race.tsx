import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Organ } from '../components/Organ';
import { Badge } from '../components/ui';
import { opinion, readMs, type OrganId, type OrganView } from '../lib/health';
import { useLang } from '../lib/i18n';

/** The organ race. Tap a character: it says one short line, for as long as it takes to read.
 *  Tap the bubble or the lane name: details. Characters move only when the data changed. */
export function Race({ organs, onOpen, critical }: { organs: OrganView[]; onOpen: (id: OrganId) => void; critical: boolean }) {
  const { t, lang } = useLang();
  const [talk, setTalk] = useState<{ id: OrganId; text: string } | null>(null);
  const [w, setW] = useState(320);
  const [size, setSize] = useState(56);
  const box = useRef<HTMLElement>(null);
  const timer = useRef<number>();

  useEffect(() => () => window.clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const track = el.querySelector('.track') as HTMLElement | null;
      setW(track?.clientWidth ?? el.clientWidth);
      setSize(Math.round(Math.max(56, Math.min(104, (track?.clientHeight ?? 62) * 0.66))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  function speak(o: OrganView) {
    window.clearTimeout(timer.current);
    if (talk?.id === o.id) return setTalk(null);
    const text = opinion(o, lang);
    setTalk({ id: o.id, text });
    timer.current = window.setTimeout(() => setTalk(null), readMs(text));
  }

  function bubbleStyle(x: number): CSSProperties {
    const roomL = x - 10;
    const roomR = w - (x + size) - 10;
    if (Math.max(roomL, roomR) >= 140) {
      return roomR >= roomL
        ? { left: x + size + 6, bottom: Math.round(size * 0.35), maxWidth: Math.min(300, roomR) }
        : { right: w - x + 6, bottom: Math.round(size * 0.35), maxWidth: Math.min(300, roomL) };
    }
    const width = Math.min(260, w);
    return { left: Math.max(0, Math.min(w - width, x - 40)), bottom: size + 6, maxWidth: width };
  }

  return (
    <section ref={box} className={`race${critical ? ' serious' : ''}`} aria-label={t('race')}>
      {organs.map((o, i) => {
        const x = (w - size) * o.frac;
        return (
          <div className="lane" key={o.id}>
            <button className="lane-head" onClick={() => onOpen(o.id)} aria-label={`${t(o.id)}: ${o.headlineValue}, ${t(`st.${o.st}` as 'st.ok')}`}>
              <span className="lane-name">{t(o.id)}</span>
              <span className="lane-val">{o.headlineValue}</span>
              <Badge st={o.st} small />
            </button>
            <div className="track">
              <span className={`rail${o.st === 'none' ? ' empty' : ''}`} />
              {o.st !== 'none' && <span className={`fill o-${o.id}`} style={{ width: x + size / 2 }} />}
              <span className="flag" aria-hidden="true" />
              <button
                className="runner"
                style={{ left: x, width: size, height: size }}
                onClick={() => speak(o)}
                aria-label={t(o.id)}
                aria-expanded={talk?.id === o.id}
              >
                <span className="bob" style={{ animationDelay: `${-i * 0.7}s` }}>
                  <Organ organ={o.id} mood={critical && o.mood === 'celebrate' ? 'neutral' : o.mood} size={size} />
                </span>
              </button>
              {talk?.id === o.id && (
                <button key={talk.text} className="bubble" style={bubbleStyle(x)} onClick={() => onOpen(o.id)} aria-live="polite">
                  {talk.text}
                  <span className="bubble-timer" style={{ animationDuration: `${readMs(talk.text)}ms` }} />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}
