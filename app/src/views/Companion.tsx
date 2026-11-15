import { useEffect, useRef, useState } from 'react';
import { Icon, Orb } from '../components/ui';
import { apiGet, apiPost } from '../lib/api';
import { useLang } from '../lib/i18n';
import type { AssistantReply, AssistantStatus, Card } from '../types';

interface Msg {
  from: 'me' | 'bot';
  text: string;
  steps?: string[];
  sources?: { label: string; url: string }[];
  understood?: string;
  emergency?: boolean;
}

/** Mission companion. With a card as context it explains that card from its own data;
 *  everything else goes to the on-board assistant (/api/assistant/ask), which always cites sources. */
export function Companion({ ctx, onClose, offline }: { ctx: Card | null; onClose: () => void; offline: boolean }) {
  const { t } = useLang();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [topics, setTopics] = useState<{ id: string; title: string }[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [voice, setVoice] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    apiGet<AssistantStatus>('/api/assistant/status')
      .then((s) => setTopics(s.topics.slice(0, 6)))
      .catch(() => setTopics([]));
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [msgs, busy]);

  function say(m: Msg) {
    setMsgs((x) => [...x, m]);
    if (voice && m.from === 'bot' && 'speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(m.text.replace(/\[S\d+\]/g, ''));
      u.lang = 'en-US';
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    }
  }

  function local(kind: 'why' | 'now') {
    if (!ctx) return;
    say({ from: 'me', text: kind === 'why' ? t('whyThis') : t('whatNow') });
    if (kind === 'why') say({ from: 'bot', text: `${ctx.headline.replace(/\.$/, "")}. ${ctx.whatWeSaw} ${ctx.why}`, sources: ctx.sources });
    else say({ from: 'bot', text: ctx.whoDecides, steps: ctx.whatToDoNow, sources: ctx.sources });
  }

  async function ask(body: Record<string, unknown>, shown: string) {
    say({ from: 'me', text: shown });
    setBusy(true);
    try {
      const r = await apiPost<AssistantReply>('/api/assistant/ask', body, 20000);
      say({
        from: 'bot',
        text: r.answer,
        steps: r.steps,
        sources: r.sources,
        emergency: r.mode === 'EMERGENCY',
        understood: r.interpretedAs?.map((x) => x.title).join(', '),
      });
    } catch {
      say({ from: 'bot', text: t('assistantOff') });
    } finally {
      setBusy(false);
    }
  }

  function send() {
    const q = draft.trim();
    if (!q) return;
    setDraft('');
    ask({ question: q }, q);
  }

  return (
    <aside className="companion" role="dialog" aria-label={t('companion')}>
      <header className="comp-head">
        <button className="icon-btn ghost" aria-label={t('close')} onClick={onClose}>
          <Icon name="back" size={22} />
        </button>
        <Orb size={38} />
        <div className="col grow">
          <b>{t('companion')}</b>
          <span className={`xs ${offline ? 'muted' : 'ok-text'}`}>{offline ? t('offline') : 'Online'}</span>
        </div>
        <button className={`icon-btn${voice ? ' on' : ''}`} aria-pressed={voice} aria-label="Voice" onClick={() => setVoice(!voice)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={voice ? 'M11 5 6 9H3v6h3l5 4V5z M15.5 8.5a5 5 0 0 1 0 7 M18.5 5.5a9 9 0 0 1 0 13' : 'M11 5 6 9H3v6h3l5 4V5z M22 9l-6 6 M16 9l6 6'} />
          </svg>
        </button>
      </header>

      <div className="comp-body" aria-live="polite">
        <div className="msg bot">
          <span className="bubble-b">{ctx ? `${t('hiCard')}: ${ctx.headline}` : t('hi')}</span>
        </div>
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.from}${m.emergency ? ' emergency' : ''}`}>
            <span className="bubble-b">
              {m.text.replace(/\[S\d+\]\s?/g, '')}
              {m.steps && m.steps.length > 0 && (
                <ol className="mini-steps">
                  {Array.from(new Set(m.steps)).slice(0, 5).map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
              )}
              {m.understood && (
                <span className="xs muted">
                  {t('understood')}: {m.understood}
                </span>
              )}
              {m.sources && m.sources.length > 0 && (
                <span className="srcs">
                  {m.sources.slice(0, 3).map((s) => (
                    <a key={s.url + s.label} href={s.url} target="_blank" rel="noreferrer">
                      {s.label}
                    </a>
                  ))}
                </span>
              )}
            </span>
          </div>
        ))}
        {busy && <div className="msg bot"><span className="bubble-b muted">{t('thinking')}</span></div>}
        <div ref={end} />
      </div>

      <div className="comp-chips">
        {ctx && (
          <>
            <button onClick={() => local('why')}>{t('whyThis')}</button>
            <button onClick={() => local('now')}>{t('whatNow')}</button>
          </>
        )}
        {!ctx && topics.map((tp) => (
          <button key={tp.id} onClick={() => ask({ entryIds: [tp.id] }, tp.title)}>
            {tp.title}
          </button>
        ))}
      </div>
      <div className="comp-input">
        <button className="help-now" onClick={() => ask({ emergency: true, trigger: { kind: 'button' } }, t('helpNow'))}>
          <Icon name="alert" size={18} /> {t('helpNow')}
        </button>
        <div className="row gap8">
          <label className="sr-only" htmlFor="ask">{t('placeholder')}</label>
          <input id="ask" value={draft} placeholder={t('placeholder')} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
          <button className="icon-btn primary round" aria-label={t('send')} onClick={send}>
            <Icon name="send" />
          </button>
        </div>
      </div>
    </aside>
  );
}
