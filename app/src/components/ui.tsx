import { useEffect, type ReactNode } from 'react';
import type { St } from '../lib/health';
import { useLang } from '../lib/i18n';

export const ICONS = {
  check: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8 12.5l2.7 2.7L16 9.8',
  tri: 'M12 3.5 2.8 19.5h18.4L12 3.5z M12 10v4.2 M12 17h.01',
  oct: 'M8.2 2.8h7.6l5.4 5.4v7.6l-5.4 5.4H8.2l-5.4-5.4V8.2z M12 7.8v5 M12 16.2h.01',
  minus: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8 12h8',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7.5V12l3 2',
  bell: 'M6 8a6 6 0 1 1 12 0c0 7 3 8.5 3 8.5H3S6 15 6 8 M10.3 20a1.9 1.9 0 0 0 3.4 0',
  close: 'M6 6l12 12 M18 6 6 18',
  back: 'M15 5l-7 7 7 7',
  chev: 'M9 5l7 7-7 7',
  pulse: 'M3 12h4l2.5-6 5 12 2.5-6H21',
  route: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M6 15V9a4 4 0 0 1 4-4h2 M18 9v6a4 4 0 0 1-4 4h-2',
  send: 'M4 12 20 4l-6 16-2.5-6.5L4 12z',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5A8 8 0 1 1 21 12z',
  cloudOk: 'M7 19a5 5 0 1 1 1-9.9A6 6 0 0 1 19.6 11 4 4 0 0 1 18 19z M9.5 14.5l2 2 3.5-4',
  cloudOff: 'M3 3l18 18 M8 6.3A6 6 0 0 1 17.7 10H18a4 4 0 0 1 2.3 7.3 M17 19H7a5 5 0 0 1-2.7-9.2',
  sync: 'M4 12a8 8 0 0 1 14-5.3 M20 4v4h-4 M20 12a8 8 0 0 1-14 5.3 M4 20v-4h4',
  plus: 'M12 5v14 M5 12h14',
  flask: 'M9 3h6 M10 3v6L4.8 18.2A2 2 0 0 0 6.5 21h11a2 2 0 0 0 1.7-2.8L14 9V3 M7.5 15h9',
  watch: 'M8 6V3h8v3 M8 18v3h8v-3 M6 8a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z M12 10v2.5l1.5 1',
  list: 'M9 6h11 M9 12h11 M9 18h11 M4 6l1 1 2-2 M4 12l1 1 2-2 M4 18l1 1 2-2',
  body: 'M12 6.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M6 9.5l6 1 6-1 M12 10.5V15 M12 15l-3 6.5 M12 15l3 6.5',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21a8 8 0 0 1 16 0',
  lock: 'M6 11h12v10H6z M8 11V8a4 4 0 0 1 8 0v3',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  exit: 'M15 4h4v16h-4 M10 8l-4 4 4 4 M6 12h10',
  up: 'M12 19V5 M6 11l6-6 6 6',
  down: 'M12 5v14 M6 13l6 6 6-6',
  alert: 'M12 3.5 2.8 19.5h18.4L12 3.5z M12 10v4.2 M12 17h.01',
  history: 'M3 12a9 9 0 1 0 3-6.7 M3 4v4h4 M12 7.5V12l3 2',
  flame: 'M12 21c-3.9 0-6.5-2.6-6.5-6.2 0-2.6 1.5-4.4 3-6 .3 1.6 1.1 2.7 2.3 3.2C10.6 9 11.6 6 14 3c.4 2.6 1.7 4.4 3 6 1 1.3 1.5 2.7 1.5 4.6 0 3.6-2.6 6.4-6.5 6.4z',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z',
  trophy: 'M8 4h8v5a4 4 0 0 1-8 0z M8 6H5a3 3 0 0 0 3 4 M16 6h3a3 3 0 0 1-3 4 M12 13v4 M8.5 20.5h7 M10 17h4v3.5h-4z',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  dumbbell: 'M6.5 6.5v11 M17.5 6.5v11 M3.5 9v6 M20.5 9v6 M6.5 12h11',
  smile: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8.5 14a4.5 4.5 0 0 0 7 0 M9 9.5h.01 M15 9.5h.01',
};
export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 20, stroke = 2, className }: { name: IconName; size?: number; stroke?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

export const ST_ICON: Record<St, IconName> = { ok: 'check', att: 'tri', crit: 'oct', none: 'minus' };

export function Badge({ st, small }: { st: St; small?: boolean }) {
  const { t } = useLang();
  return (
    <span className={`badge st-${st}${small ? ' sm' : ''}`}>
      <Icon name={ST_ICON[st]} size={small ? 12 : 14} stroke={2.4} />
      {t(`st.${st}` as 'st.ok')}
    </span>
  );
}

export function Sheet({ title, onClose, children, footer, onBack, wide }: { title?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; onBack?: () => void; wide?: boolean }) {
  const { t } = useLang();
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="sheet-wrap">
      <button className="scrim" aria-label={t('close')} onClick={onClose} />
      <section className={`sheet${wide ? ' wide' : ''}`} role="dialog" aria-modal="true">
        <header className="sheet-head">
          {onBack ? (
            <button className="icon-btn ghost" aria-label={t('back')} onClick={onBack}>
              <Icon name="back" size={22} />
            </button>
          ) : null}
          <h2>{title}</h2>
          <button className="icon-btn" aria-label={t('close')} onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="sheet-body">{children}</div>
        {footer ? <footer className="sheet-foot">{footer}</footer> : null}
      </section>
    </div>
  );
}

export function Toast({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div className="toast" role="status">
      {text}
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="group">
      {options.map((o) => (
        <button key={o.id} aria-pressed={value === o.id} className={value === o.id ? 'on' : ''} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Chips<T extends string>({ value, options, onChange, label }: { value: T | ''; options: { id: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="chips" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} role="radio" aria-checked={value === o.id} className={value === o.id ? 'on' : ''} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Orb({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r="21" fill="#7D57FF" stroke="#fff" strokeWidth="2" />
      <ellipse cx="16" cy="13" rx="6" ry="3.5" fill="#fff" opacity="0.35" transform="rotate(-25 16 13)" />
      <rect x="10" y="17" width="28" height="15" rx="7.5" fill="#0D1B2E" />
      <rect x="16" y="20.5" width="4.5" height="8" rx="2.25" fill="#7FF3EA" />
      <rect x="27.5" y="20.5" width="4.5" height="8" rx="2.25" fill="#7FF3EA" />
    </svg>
  );
}
