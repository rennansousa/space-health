import { useMemo, useState } from 'react';
import { BodyView } from '../components/BodyView';
import { Organ } from '../components/Organ';
import { Badge, Chips, Icon, Seg, Sheet, ST_ICON } from '../components/ui';
import type { Card, CrewState } from '../types';
import {
  fmt, REGION_IDS, REGION_ORGANS, regionViews, sortedCards, tierSt, timeline,
  type HistKind, type OrganId, type OrganView, type RegionId, type St,
} from '../lib/health';
import { ago, clock, useLang } from '../lib/i18n';

// ---------------- organ details

export function OrganSheet({ o, onClose, onCard, onAsk }: { o: OrganView; onClose: () => void; onCard: (c: Card) => void; onAsk: () => void }) {
  const { t, lang } = useLang();
  return (
    <Sheet
      title={t(o.id)}
      onClose={onClose}
      footer={
        <button className="btn violet" onClick={onAsk}>
          <Icon name="chat" /> {t('askAbout')}
        </button>
      }
    >
      <div className="organ-hero">
        <div className="organ-pad">
          <Organ organ={o.id} mood={o.mood} size={96} />
        </div>
        <div className="col gap8">
          <Badge st={o.st} />
          {o.lastAt && <span className="muted sm">{t('lastReading')} · {ago(o.lastAt, lang)}</span>}
        </div>
      </div>

      {o.st === 'none' && <p className="empty">{t('noRecords')}</p>}

      {o.vitals.map((v) => (
        <div className="metric" key={v.type}>
          <div className="metric-top">
            <span className="metric-name">{v.label}</span>
            <Badge st={v.status === 'IN_RANGE' ? 'ok' : 'att'} small />
          </div>
          <div className="metric-val">
            {fmt(v.value)} <small>{v.unit}</small>
          </div>
          <dl className="meta">
            <dt>{t('range')}</dt>
            <dd>{v.normalRange.map((x) => (x === null ? '—' : x)).join(' – ')}</dd>
            <dt>{t('source')}</dt>
            <dd>{v.adapter} · {clock(v.measuredAtUtc)}</dd>
          </dl>
        </div>
      ))}

      {o.cards.map((c) => (
        <button className="metric as-btn" key={c.cardId} onClick={() => onCard(c)}>
          <div className="metric-top">
            <span className="metric-name">{c.label}</span>
            <Badge st={tierSt(c.riskTier)} small />
          </div>
          <div className="metric-val">
            {fmt(c.value)} <small>{c.unit}</small>
          </div>
          <span className="muted sm">{c.headline} · {c.drawLabel}</span>
        </button>
      ))}

      {o.findings.filter((f) => !o.cards.some((c) => c.analyte === f.analyte)).length > 0 && (
        <div className="table-card">
          <span className="label">{t('values')}</span>
          {o.findings
            .filter((f) => !o.cards.some((c) => c.analyte === f.analyte))
            .map((f) => (
              <div className="row" key={f.analyte}>
                <span>{f.label}</span>
                <b>
                  {fmt(f.value)} <small>{f.unit}</small>
                </b>
              </div>
            ))}
        </div>
      )}
    </Sheet>
  );
}

// ---------------- guidance centre: new + history

export function GuidanceSheet({ state, acked, onClose, onCard }: { state: CrewState; acked: Set<string>; onClose: () => void; onCard: (c: Card) => void }) {
  const { t, lang } = useLang();
  const [tab, setTab] = useState<'new' | 'hist'>('new');
  const [kind, setKind] = useState<HistKind | 'all'>('all');
  const fresh = sortedCards(state.cards).filter((c) => !acked.has(c.cardId) && c.riskTier !== 'ROUTINE');
  const items = useMemo(() => timeline(state, lang), [state, lang]);
  const shown = kind === 'all' ? items : items.filter((i) => i.kind === kind);
  const KIND_ICON: Record<HistKind, Parameters<typeof Icon>[0]['name']> = { exam: 'flask', symptom: 'body', decision: 'check', action: 'list', signal: 'pulse' };

  return (
    <Sheet title={t('guidance')} onClose={onClose}>
      <Seg
        value={tab}
        onChange={setTab}
        options={[
          { id: 'new', label: `${t('newTab')} · ${fresh.length}` },
          { id: 'hist', label: t('historyTab') },
        ]}
      />
      {tab === 'new' && (
        <div className="col gap10">
          {fresh.length === 0 && <p className="empty">{t('allClear')}</p>}
          {fresh.map((c) => (
            <GuidanceRow key={c.cardId} c={c} onClick={() => onCard(c)} />
          ))}
          {sortedCards(state.cards)
            .filter((c) => acked.has(c.cardId) || c.riskTier === 'ROUTINE')
            .map((c) => (
              <GuidanceRow key={c.cardId} c={c} onClick={() => onCard(c)} quiet />
            ))}
        </div>
      )}
      {tab === 'hist' && (
        <div className="col gap10">
          <Chips
            label={t('historyTab')}
            value={kind}
            onChange={setKind}
            options={[
              { id: 'all', label: t('all') },
              { id: 'exam', label: t('exams') },
              { id: 'symptom', label: t('symptoms') },
              { id: 'decision', label: t('decisions') },
              { id: 'action', label: t('actions') },
              { id: 'signal', label: t('signals') },
            ]}
          />
          <ol className="timeline">
            {shown.map((i) => (
              <li key={i.id} className={`tl k-${i.kind}`}>
                <span className="tl-dot">
                  <Icon name={KIND_ICON[i.kind]} size={16} />
                </span>
                <div className="tl-body">
                  <div className="tl-top">
                    <b>{i.title}</b>
                    {i.st && i.st !== 'ok' && <Badge st={i.st} small />}
                  </div>
                  <span className="muted sm">{i.detail}</span>
                  <span className="muted xs">
                    {i.at ? clock(i.at) : ''}
                    {i.kind === 'symptom' ? ` · ${t('reported')}` : ''}
                    {i.pending ? ` · ${t('pendingSync')}` : ''}
                  </span>
                </div>
              </li>
            ))}
            {shown.length === 0 && <p className="empty">{t('noRecords')}</p>}
          </ol>
        </div>
      )}
    </Sheet>
  );
}

function GuidanceRow({ c, onClick, quiet }: { c: Card; onClick: () => void; quiet?: boolean }) {
  const st = tierSt(c.riskTier);
  const done = (c.stepsDone ?? []).filter(Boolean).length;
  return (
    <button className={`g-row${quiet ? ' quiet' : ''}`} onClick={onClick}>
      <span className={`g-ico st-${st}`}>
        <Icon name={ST_ICON[st]} size={20} />
      </span>
      <span className="col grow">
        <b>{c.headline}</b>
        <span className="muted sm">
          {fmt(c.value)} {c.unit} · {c.drawLabel} · {done}/{c.whatToDoNow.length}
        </span>
      </span>
      <Icon name="chev" size={18} />
    </button>
  );
}

// ---------------- one orientation (a card)

export function CardSheet({
  c, acked, onAck, onBack, onClose, onStep, onAsk,
}: { c: Card; acked: boolean; onAck: () => void; onBack?: () => void; onClose: () => void; onStep: (i: number, done: boolean) => void; onAsk: () => void }) {
  const { t } = useLang();
  const st = tierSt(c.riskTier);
  const r = c.review;
  return (
    <Sheet
      title={c.label}
      onClose={onClose}
      onBack={onBack}
      footer={
        <div className="row gap10">
          {!acked && st !== 'crit' && (
            <button className="btn" onClick={onAck}>
              {t('acknowledge')}
            </button>
          )}
          <button className="btn violet grow" onClick={onAsk}>
            <Icon name="chat" /> {t('whyThis')}
          </button>
        </div>
      }
    >
      <div className="col gap8">
        <Badge st={st} />
        <h3 className="card-title">{c.headline}</h3>
      </div>
      {r?.humanDirective && (
        <div className="directive">
          <b>{t('directive')}</b>
          <span>{r.humanDirective}</span>
          <span className="xs">{r.decidedBy} · {clock(r.decidedAtUtc)}</span>
        </div>
      )}
      <section className="block">
        <span className="label">{t('whatHappened')}</span>
        <p>{c.whatWeSaw}</p>
      </section>
      <section className="block">
        <span className="label">{t('whyMatters')}</span>
        <p>{c.why}</p>
      </section>
      <section className="block">
        <span className="label">{t('whatToDo')}</span>
        <ol className="steps">
          {c.whatToDoNow.map((s, i) => {
            const done = !!c.stepsDone?.[i];
            return (
              <li key={i}>
                <button className={`step${done ? ' done' : ''}`} aria-pressed={done} onClick={() => onStep(i, !done)}>
                  <span className="tick">{done ? <Icon name="check" size={18} /> : i + 1}</span>
                  <span>{s}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </section>
      <section className="block">
        <span className="label">{t('whoDecides')}</span>
        <p>{c.whoDecides}</p>
        {r && <span className="muted sm">{r.label}</span>}
      </section>
      {c.sources.length > 0 && (
        <section className="block">
          <span className="label">{t('sources')}</span>
          {c.sources.map((s) => (
            <a key={s.url} href={s.url} target="_blank" rel="noreferrer">
              {s.label}
            </a>
          ))}
        </section>
      )}
    </Sheet>
  );
}

// ---------------- body + symptoms

export function BodySheet({ state, organs, initial, onClose, onReport }: { state: CrewState; organs: OrganView[]; initial?: RegionId; onClose: () => void; onReport: (r: RegionId) => void }) {
  const { t } = useLang();
  const regions = useMemo(() => regionViews(state, organs), [state, organs]);
  const [sel, setSel] = useState<RegionId>(() => initial ?? regions.find((r) => r.st === 'crit' || r.st === 'att')?.id ?? 'chest');
  const status = useMemo(() => Object.fromEntries(regions.map((r) => [r.id, r.st])) as Record<RegionId, St>, [regions]);
  const organSt = useMemo(() => Object.fromEntries(organs.map((o) => [o.id, o.st])) as Partial<Record<OrganId, St>>, [organs]);
  const cur = regions.find((r) => r.id === sel)!;
  return (
    <Sheet
      title={t('bodyTitle')}
      onClose={onClose}
      wide
      footer={
        <button className="btn primary" onClick={() => onReport(sel)}>
          <Icon name="plus" /> {t('reportSymptom')}
        </button>
      }
    >
      <div className="body-layout">
        <div className="sheet-body3d">
          <BodyView status={status} organSt={organSt} selected={sel} onSelect={setSel} label={t('bodyTitle')} />
        </div>
        <div className="col gap10 grow">
          <div className="region-list" role="radiogroup" aria-label={t('bodyTitle')}>
            {regions.map((r) => (
              <button key={r.id} role="radio" aria-checked={sel === r.id} className={`region-chip${sel === r.id ? ' on' : ''}`} onClick={() => setSel(r.id)}>
                <span className={`dot st-${r.st}`} />
                {t(r.id)}
                {r.symptoms.length > 0 && <span className="count">{r.symptoms.length}</span>}
              </button>
            ))}
          </div>
          <div className="region-card">
            <div className="row between">
              <h3>{t(sel)}</h3>
              <Badge st={cur.st} />
            </div>
            {REGION_ORGANS[sel].length > 0 && (
              <div className="row gap8 wrap">
                {REGION_ORGANS[sel].map((id) => {
                  const o = organs.find((x) => x.id === id)!;
                  return (
                    <span className="organ-tag" key={id}>
                      <Organ organ={id} mood={o.mood} size={28} /> {t(id)}
                    </span>
                  );
                })}
              </div>
            )}
            {cur.vitals.map((v) => (
              <div className="row between sm" key={v.type}>
                <span>{v.label}</span>
                <b>
                  {fmt(v.value)} {v.unit}
                </b>
              </div>
            ))}
            {cur.cards.map((c) => (
              <div className="row between sm" key={c.cardId}>
                <span>{c.headline}</span>
                <Badge st={tierSt(c.riskTier)} small />
              </div>
            ))}
            {cur.symptoms.map((s) => (
              <div className="sym-line" key={s.recordId}>
                <b>{s.discomfortType}</b> · {s.intensity} · {clock(s.createdAtUtc)} <span className="tag">{t('reported')}</span>
              </div>
            ))}
            {!cur.cards.length && !cur.vitals.length && !cur.symptoms.length && <p className="empty">{t('nothingHere')}</p>}
          </div>
          <span className="muted xs">3D: HuBMAP CCF Reference Organs · CC BY 4.0</span>
        </div>
      </div>
    </Sheet>
  );
}

const SYM_TYPES = ['sym.pain', 'sym.pressure', 'sym.nausea', 'sym.dizzy', 'sym.numb', 'sym.tired', 'sym.other'] as const;
const ONSETS = ['on.now', 'on.1h', 'on.today', 'on.yday'] as const;
const DURS = ['du.ongoing', 'du.min', 'du.hours', 'du.days'] as const;

export function SymptomSheet({ region, onClose, onBack, onSave }: { region: RegionId; onClose: () => void; onBack: () => void; onSave: (b: Record<string, string>) => Promise<void> }) {
  const { t } = useLang();
  const [reg, setReg] = useState<RegionId>(region);
  const [type, setType] = useState<(typeof SYM_TYPES)[number] | ''>('');
  const [intensity, setIntensity] = useState<'mild' | 'moderate' | 'severe'>('mild');
  const [onset, setOnset] = useState<(typeof ONSETS)[number]>('on.now');
  const [dur, setDur] = useState<(typeof DURS)[number]>('du.ongoing');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Sheet
      title={t('symptomTitle')}
      onClose={onClose}
      onBack={onBack}
      footer={
        <button
          className="btn primary"
          disabled={!type || busy}
          onClick={async () => {
            setBusy(true);
            await onSave({ region: reg, discomfortType: t(type as 'sym.pain'), intensity: t(intensity), onset: t(onset), duration: t(dur), description: notes.trim() });
            setBusy(false);
          }}
        >
          {t('save')}
        </button>
      }
    >
      <div className="form">
        <span className="label">{t('where')}</span>
        <Chips label={t('where')} value={reg} onChange={setReg} options={REGION_IDS.map((id) => ({ id, label: t(id) }))} />
        <span className="label">{t('what')}</span>
        <Chips label={t('what')} value={type} onChange={setType} options={SYM_TYPES.map((id) => ({ id, label: t(id) }))} />
        <span className="label">{t('howStrong')}</span>
        <Seg value={intensity} onChange={setIntensity} options={(['mild', 'moderate', 'severe'] as const).map((id) => ({ id, label: t(id) }))} />
        <span className="label">{t('since')}</span>
        <Chips label={t('since')} value={onset} onChange={setOnset} options={ONSETS.map((id) => ({ id, label: t(id) }))} />
        <span className="label">{t('howLong')}</span>
        <Chips label={t('howLong')} value={dur} onChange={setDur} options={DURS.map((id) => ({ id, label: t(id) }))} />
        <label className="label" htmlFor="sym-notes">
          {t('notes')}
        </label>
        <textarea id="sym-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={280} />
      </div>
    </Sheet>
  );
}
