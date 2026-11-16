// In-browser demo engine mirroring backend/server.py + backend/assistant.py.
// Used automatically on static hosts (GitHub Pages, etc.) and as a seamless
// fallback when the local Python API server is not running.

import rawSeed from './demoSeed.json';
import type {
  AssistantReply,
  AssistantSource,
  AssistantStatus,
  Card,
  CrewState,
  GroundState,
  ManualSymptom,
  User,
} from '../types';

const DEMO_STATE_KEY = 'sh.demo.state.v1';

interface CorpusEntry {
  id: string;
  category: string;
  title: string;
  keywords?: string[];
  text: string;
  steps?: string[];
  sources: { label: string; url: string }[];
  boost?: number;
}

interface DemoSeed {
  users: User[];
  demoPin: string;
  crew: Record<string, CrewState>;
  ground: GroundState;
  assistantStatus: AssistantStatus;
  corpus: CorpusEntry[];
}

const SEED = rawSeed as unknown as DemoSeed;

export class DemoError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let memState: DemoSeed | null = null;
let saveTimer: number | null = null;

function cloneSeed(): DemoSeed {
  return JSON.parse(JSON.stringify(SEED)) as DemoSeed;
}

function loadState(): DemoSeed {
  if (memState) return memState;
  const base = cloneSeed();
  try {
    const raw = window.localStorage.getItem(DEMO_STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DemoSeed>;
      if (parsed && parsed.crew && parsed.ground) {
        base.crew = parsed.crew;
        base.ground = parsed.ground;
      }
    }
  } catch {
    /* ignore corrupt storage */
  }
  memState = base;
  return memState;
}

function saveState(state: DemoSeed): void {
  memState = state;
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    try {
      window.localStorage.setItem(DEMO_STATE_KEY, JSON.stringify({ crew: state.crew, ground: state.ground }));
    } catch {
      /* ignore storage quota errors */
    }
  }, 0);
}

function resolveCrewTarget(user: User | null, requested: string | null): string {
  if (!user) throw new DemoError(401, 'Sign in first.');
  if (user.role === 'CREW') {
    if (requested && requested !== user.user_id) {
      throw new DemoError(403, 'Crew members can only see their own data.');
    }
    return user.user_id;
  }
  if (user.role === 'CREW_MEDICAL_OFFICER') {
    return requested || 'C003';
  }
  throw new DemoError(403, 'This is a crew-side action.');
}

// ---------------- Assistant retrieval & guardrails (mirrors backend/assistant.py)

const DISCLAIMER = 'Prototype assistant. It explains results and checked protocols; it does not diagnose or prescribe.';

const EMERGENCY_PATTERNS = [
  /chest pain/i, /pain in (my|the) chest/i, /can'?t breathe/i, /cannot breathe/i, /not breathing/i,
  /trouble breathing/i, /unconscious/i, /passed out/i, /fainted/i, /unresponsive/i, /won'?t wake/i,
  /seizure/i, /convuls/i, /(severe|heavy|a lot of) bleeding/i, /bleeding (a lot|heavily)/i, /stroke/i,
  /face (is )?droop/i, /slurred speech/i, /can'?t (move|feel) (my )?(arm|leg|face)/i, /anaphyla/i,
  /throat (is )?(closing|swelling)/i, /tongue (is )?swelling/i, /(lips?|face|skin) (is |are )?(turning |going )?blue/i,
  /turning blue/i, /not (responding|answering|waking)/i, /can'?t wake/i, /chok(ing|es|ed)/i, /collaps/i,
  /kill myself/i, /suicid/i, /end my life/i, /hurt myself/i, /self[- ]harm/i,
  /\bfire\b/i, /\bsmoke\b/i, /depressuri/i, /toxic (leak|spill|release)/i, /ammonia/i,
  /dor no peito/i, /nao consigo respirar/i, /desmai/i, /inconscien/i, /sangramento (forte|grave)/i,
  /nao (responde|acorda)/i, /(labios?|boca) (roxos?|azu)/i, /engasg/i, /\bavc\b/i, /me matar/i,
];

const MEDICINE_PATTERNS = [
  /\bdose\b/i, /\bdosage\b/i, /\bdosing\b/i, /\bmg\b/i, /milligram/i, /\bpills?\b/i, /\btablets?\b/i,
  /\bcapsules?\b/i, /prescri/i, /\bmedicines?\b/i, /\bmedications?\b/i, /\bdrugs?\b/i, /antibiotic/i,
  /painkiller/i, /ibuprofen/i, /acetaminophen/i, /paracetamol/i, /aspirin/i, /promethazine/i,
  /scopolamine/i, /insulin/i, /remedio/i, /medicamento/i, /comprimido/i, /quantos mg/i,
];

const SYNONYMS: Record<string, string> = {
  potassio: 'potassium', glicose: 'glucose', sodio: 'sodium', calcio: 'calcium', ureia: 'urea bun',
  creatinina: 'creatinine', enjoo: 'nausea', tontura: 'dizziness', visao: 'vision', cabeca: 'headache',
  acucar: 'glucose sugar', sugar: 'glucose', bun: 'urea', k: 'potassium', na: 'sodium',
  pulse: 'heart rate', fever: 'temperature', oxygen: 'spo2', saturation: 'spo2',
  throwing: 'vomit', throw: 'vomit', puke: 'vomit', spinning: 'dizzy', vertigo: 'dizzy', queasy: 'nausea',
  fog: 'foggy', focus: 'concentrate', blurry: 'blur vision', embacada: 'blur vision', fuzzy: 'blur vision',
  latejando: 'headache', abafado: 'stuffy co2', vomito: 'vomit', vomitando: 'vomit',
  coracao: 'heart', pulmao: 'lung respiratory', rins: 'kidney creatinine bun', figado: 'liver alt ast bilirubin',
  cerebro: 'brain neuro headache vision',
};

const STOP_WORDS = new Set(
  'a an the is are was were be been my me i you your of to in on for and or it this that what why how do does did should can could would with at by from as about have has had not no yes am will just up down since get got feel feels feeling like things thing look looks really very so we us our here there now when o a os as um uma de da do das dos em no na nos nas para por com que qual como porque'.split(' '),
);

function normText(text: string): string {
  return (text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function tokenize(text: string): string[] {
  const words = normText(text).match(/[a-z0-9]+/g) ?? [];
  const out: string[] = [];
  for (const w of words) {
    if (STOP_WORDS.has(w)) continue;
    out.push(w);
    if (SYNONYMS[w]) out.push(...SYNONYMS[w].split(' '));
    if (w.length > 4 && w.endsWith('s')) out.push(w.slice(0, -1));
  }
  return out;
}

function cardEntries(cards: Card[]): CorpusEntry[] {
  return (cards || []).map((c) => ({
    id: `MY_${c.analyte}`,
    category: 'MY_RESULT',
    title: `Your result: ${c.headline}`,
    keywords: [c.label || '', c.analyte.replace(/_/g, ' ').toLowerCase(), 'my', 'result', (c.status || '').toLowerCase()],
    text: `${c.whatWeSaw || ''} ${c.why || ''}`.trim(),
    steps: c.whatToDoNow || [],
    sources: c.sources?.length ? c.sources : [{ label: 'Your latest draw', url: 'local:card' }],
    boost: 1.3,
  }));
}

function bm25(query: string, docs: CorpusEntry[]): { score: number; doc: CorpusEntry }[] {
  const q = tokenize(query);
  if (!q.length || !docs.length) return [];
  const docTokens = docs.map((d) =>
    tokenize([d.title, (d.keywords ?? []).join(' '), (d.keywords ?? []).join(' '), d.text || '', (d.steps ?? []).join(' ')].join(' ')),
  );
  const avg = docTokens.reduce((s, t) => s + t.length, 0) / docTokens.length || 1;
  const n = docs.length;
  const df: Record<string, number> = {};
  for (const toks of docTokens) {
    for (const t of new Set(toks)) df[t] = (df[t] || 0) + 1;
  }
  const k1 = 1.4;
  const b = 0.75;
  const qUnique = Array.from(new Set(q));
  const scored = docs.map((doc, idx) => {
    const toks = docTokens[idx];
    const tf: Record<string, number> = {};
    for (const t of toks) tf[t] = (tf[t] || 0) + 1;
    let s = 0;
    for (const t of qUnique) {
      if (!tf[t]) continue;
      const idf = Math.log(1 + (n - (df[t] || 0) + 0.5) / ((df[t] || 0) + 0.5));
      s += (idf * tf[t] * (k1 + 1)) / (tf[t] + k1 * (1 - b + (b * toks.length) / avg));
    }
    return { score: s * (doc.boost ?? 1), doc };
  });
  return scored.sort((a, b2) => b2.score - a.score);
}

function sourcesOf(docs: CorpusEntry[]): AssistantSource[] {
  const out: AssistantSource[] = [];
  const seen = new Set<string>();
  docs.forEach((d, idx) => {
    for (const s of d.sources || []) {
      const key = s.url || s.label;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ref: `S${idx + 1}`, entryId: d.id, label: s.label || '', url: s.url || '' });
    }
  });
  return out;
}

function extractive(docs: CorpusEntry[]): string {
  return docs
    .map((d, idx) => {
      let line = `[S${idx + 1}] ${d.title}. ${d.text}`.trim();
      if (d.steps?.length) {
        line += ' What to do: ' + d.steps.map((s, j) => `(${j + 1}) ${s}`).join(' ');
      }
      return line;
    })
    .join('\n\n');
}

function askAssistant(state: DemoSeed, target: string, b: Record<string, unknown>): AssistantReply {
  const cards = state.crew[target]?.cards ?? [];
  const corpus = [...state.corpus, ...cardEntries(cards)];
  const byId = new Map(corpus.map((d) => [d.id, d]));

  if (b.emergency) {
    const trigger = (b.trigger as Record<string, unknown> | undefined) ?? {};
    const kind = trigger.kind === 'sound' ? 'sound' : 'button';
    const detail = String(trigger.detail ?? '').slice(0, 80);
    return {
      question: String(b.question || '').trim() || `[emergency ${kind}${detail ? ': ' + detail : ''}]`,
      mode: 'EMERGENCY',
      engine: 'fixed',
      answer:
        'This may be an emergency. Call your Crew Medical Officer now, or any crewmate if you cannot reach them, and start the onboard emergency procedure for this situation. Do not wait for the ground. Space Health has queued an alert for the flight surgeon.',
      steps: [
        'Call your Crew Medical Officer now.',
        'Start the onboard emergency procedure.',
        'Stay with the crew member until help arrives.',
      ],
      sources: [],
      guardrails: [`emergency_${kind}`],
      disclaimer: DISCLAIMER,
      alert: { sent: true, demoDelaySeconds: state.crew[target]?.link.demoDelaySeconds ?? 4 },
    };
  }

  const entryIds = Array.isArray(b.entryIds) ? (b.entryIds as string[]) : null;
  if (entryIds && entryIds.length > 0) {
    const docs = Array.from(new Set(entryIds)).map((id) => byId.get(id)).filter((d): d is CorpusEntry => Boolean(d)).slice(0, 3);
    if (!docs.length) throw new DemoError(400, 'Unknown topic. Choose one from the list on screen.');
    return {
      question: String(b.question || '').trim() || '[topic chosen on screen]',
      mode: 'ANSWER',
      engine: 'selected',
      answer: extractive(docs),
      steps: docs.flatMap((d) => d.steps ?? []).slice(0, 5),
      sources: sourcesOf(docs),
      guardrails: [],
      disclaimer: DISCLAIMER,
      interpretedAs: docs.map((d) => ({ entryId: d.id, title: d.title, by: 'tap' })),
    };
  }

  const question = String(b.question || '').trim();
  if (!question) throw new DemoError(400, 'Ask a question, for example: why is my potassium flagged?');
  if (question.length > 500) throw new DemoError(400, 'Keep the question under 500 characters.');

  const normQ = normText(question);
  if (EMERGENCY_PATTERNS.some((p) => p.test(normQ))) {
    return {
      question,
      mode: 'EMERGENCY',
      engine: 'fixed',
      answer:
        'This may be an emergency. Call your Crew Medical Officer now, or any crewmate if you cannot reach them, and start the onboard emergency procedure for this situation. Do not wait for the ground. Space Health has queued an alert for the flight surgeon.',
      steps: [
        'Call your Crew Medical Officer now.',
        'Start the onboard emergency procedure.',
        'Stay with the crew member until help arrives.',
      ],
      sources: [],
      guardrails: ['emergency_words'],
      disclaimer: DISCLAIMER,
      alert: { sent: true, demoDelaySeconds: state.crew[target]?.link.demoDelaySeconds ?? 4 },
    };
  }

  const medicineWords = MEDICINE_PATTERNS.some((p) => p.test(normQ));
  const ranked = bm25(question, corpus).filter((r) => r.score > 0);
  const best = ranked[0]?.score ?? 0;
  const top = ranked.slice(0, 3).filter((r) => r.score >= Math.max(1.2, best * 0.6)).map((r) => r.doc);

  if (medicineWords) {
    const strong = best >= 1.2;
    return {
      question,
      mode: 'MEDICINE_REFUSED',
      engine: 'fixed',
      guardrails: ['medicine_or_dose'],
      answer:
        'Medicines and doses are decided by your Crew Medical Officer with the flight surgeon, using the onboard medical checklist. I can explain your results and the checked protocols, but I do not choose or dose a medicine.',
      steps: ['Ask your Crew Medical Officer.'],
      sources: strong ? sourcesOf(top) : [],
      related: strong ? extractive(top) : '',
      disclaimer: DISCLAIMER,
    };
  }

  if (best < 1.2 || !top.length) {
    const topics = Array.from(new Set(corpus.filter((d) => d.category !== 'MY_RESULT').map((d) => d.title))).sort();
    return {
      question,
      mode: 'OUT_OF_SCOPE',
      engine: 'fixed',
      guardrails: ['no_checked_protocol'],
      answer:
        "I don't have a checked protocol for that. Ask your Crew Medical Officer. I only answer from the protocols loaded on board and from your own latest results. You can also tap a topic below.",
      topics,
      sources: [],
      disclaimer: DISCLAIMER,
    };
  }

  const alternatives = ranked
    .map((r) => r.doc)
    .filter((d) => !top.includes(d))
    .slice(0, 3)
    .map((d) => ({ entryId: d.id, title: d.title }));

  return {
    question,
    mode: 'ANSWER',
    engine: 'extractive',
    guardrails: [],
    answer: extractive(top),
    steps: top.flatMap((d) => d.steps ?? []).slice(0, 5),
    sources: sourcesOf(top),
    interpretedAs: top.slice(0, 1).map((d) => ({ entryId: d.id, title: d.title, by: 'keywords' })),
    alternatives,
    disclaimer: DISCLAIMER,
  };
}

// ---------------- Main router

const REVIEW_LABELS: Record<string, string> = {
  APPROVED: 'Confirmed by Flight Surgeon',
  REJECTED: 'Flight Surgeon did not confirm this guidance',
  DIRECTIVE_SENT: 'Directive from Flight Surgeon',
};

export function demoRequest<T>(method: 'GET' | 'POST', rawPath: string, body?: unknown, currentUser?: User | null): T {
  const [pathOnly, qs = ''] = rawPath.split('?');
  const path = pathOnly.replace(/\/$/, '') || '/';
  const query = new URLSearchParams(qs);
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const state = loadState();

  if (method === 'GET' && path === '/api/health') {
    return { status: 'ONLINE', service: 'Space Health Demo (In-Browser)', databases: true } as T;
  }

  if (method === 'GET' && path === '/api/users') {
    return { users: state.users, demoPin: state.demoPin } as T;
  }

  if (method === 'POST' && path === '/api/login') {
    const userId = String(b.userId ?? '');
    const pin = String(b.pin ?? '');
    const user = state.users.find((u) => u.user_id === userId);
    if (!user || (pin && pin !== state.demoPin)) {
      throw new DemoError(401, 'Wrong user or PIN.');
    }
    return { token: `demo-token-${user.user_id}`, user } as T;
  }

  if (method === 'POST' && path === '/api/demo/reset') {
    memState = cloneSeed();
    try {
      window.localStorage.removeItem(DEMO_STATE_KEY);
    } catch {
      /* ignore */
    }
    return { ok: true } as T;
  }

  if (!currentUser) throw new DemoError(401, 'Sign in first.');

  if (method === 'GET' && path === '/api/crew/state') {
    const target = resolveCrewTarget(currentUser, query.get('astronautId'));
    const crewState = state.crew[target];
    if (!crewState) throw new DemoError(404, `Unknown crew member ${target}.`);
    const result: CrewState = { ...crewState };
    if (currentUser.role === 'CREW_MEDICAL_OFFICER') {
      result.crewList = state.users.filter((u) => u.role === 'CREW');
    }
    return result as T;
  }

  if (method === 'POST' && path === '/api/cards/step') {
    const target = resolveCrewTarget(currentUser, (b.astronautId as string | undefined) ?? null);
    const crewState = state.crew[target];
    if (!crewState) throw new DemoError(404, `Unknown crew member ${target}.`);
    const cardId = String(b.cardId ?? '');
    const stepIndex = Number(b.stepIndex ?? 0);
    const done = Boolean(b.done ?? true);
    const card = crewState.cards.find((c) => c.cardId === cardId);
    if (card) {
      const steps = [...(card.stepsDone ?? card.whatToDoNow.map(() => false))];
      const wasDone = Boolean(steps[stepIndex]);
      steps[stepIndex] = done;
      card.stepsDone = steps;
      if (done && !wasDone) crewState.astronaut.xp += 10;

      let total = 0;
      let completed = 0;
      for (const c of crewState.cards) {
        if (c.riskTier !== 'ROUTINE') {
          const arr = c.stepsDone ?? [];
          total += c.whatToDoNow.length;
          completed += arr.filter(Boolean).length;
        }
      }
      crewState.progress = {
        done: completed,
        total,
        pct: total ? Math.round((100 * completed) / total) : 100,
      };
    }
    for (const gov of state.ground.governance) {
      const gc = gov.cards.find((c) => c.cardId === cardId);
      if (gc) {
        const steps = [...(gc.stepsDone ?? gc.whatToDoNow.map(() => false))];
        steps[stepIndex] = done;
        gc.stepsDone = steps;
      }
    }
    saveState(state);
    return { cardId, stepIndex, done } as T;
  }

  if (method === 'POST' && path === '/api/symptoms') {
    const target = resolveCrewTarget(currentUser, (b.astronautId as string | undefined) ?? null);
    const crewState = state.crew[target];
    if (!crewState) throw new DemoError(404, `Unknown crew member ${target}.`);
    const region = String(b.region ?? '').trim();
    const discomfortType = String(b.discomfortType ?? '').trim();
    if (!region || !discomfortType) {
      throw new DemoError(400, 'Body region and discomfort type are required.');
    }
    const now = new Date().toISOString();
    const record: ManualSymptom = {
      recordId: `REC-${Date.now().toString(36)}`,
      astronautId: target,
      displayName: crewState.astronaut.displayName,
      region,
      discomfortType,
      intensity: String(b.intensity ?? 'leve').trim(),
      onset: String(b.onset ?? 'Agora').trim(),
      duration: String(b.duration ?? 'Em andamento').trim(),
      description: String(b.description ?? '').trim().slice(0, 500),
      provenance: 'Reported by the astronaut (manual entry)',
      syncStatus: 'LOCAL_ONLY_OFFLINE',
      createdAtUtc: now,
    };
    crewState.symptoms = [record, ...(crewState.symptoms ?? [])];
    crewState.pendingUploadRecords += 1;
    crewState.astronaut.xp += 5;
    saveState(state);
    return record as T;
  }

  if (method === 'POST' && path === '/api/sync/downlink') {
    const target = resolveCrewTarget(currentUser, null);
    const crewState = state.crew[target];
    if (crewState?.link.blackout) {
      throw new DemoError(409, 'No link to Earth right now. Records stay on board and will be sent later.', 'NO_LINK');
    }
    const now = new Date().toISOString();
    const existingIds = new Set((state.ground.symptoms ?? []).map((s) => s.recordId));
    for (const c of Object.values(state.crew)) {
      c.lastSyncUtc = now;
      c.pendingUploadRecords = 0;
      c.symptoms = (c.symptoms ?? []).map((s) => {
        const synced = { ...s, syncStatus: 'SYNCED_WITH_EARTH', receivedAtUtc: s.receivedAtUtc ?? now };
        if (!existingIds.has(s.recordId)) {
          existingIds.add(s.recordId);
          state.ground.symptoms = [synced, ...(state.ground.symptoms ?? [])];
        }
        return synced;
      });
    }
    saveState(state);
    return {
      packetId: `PKT-DOWN-${Date.now().toString(36)}`,
      records: {},
      arrivesAtUtc: now,
      demoDelaySeconds: crewState?.link.demoDelaySeconds ?? 3,
    } as T;
  }

  if (method === 'GET' && path === '/api/assistant/status') {
    return state.assistantStatus as T;
  }

  if (method === 'POST' && path === '/api/assistant/ask') {
    const target = resolveCrewTarget(currentUser, (b.astronautId as string | undefined) ?? null);
    return askAssistant(state, target, b) as T;
  }

  if (method === 'GET' && path === '/api/ground/state') {
    if (currentUser.role !== 'FLIGHT_SURGEON') {
      throw new DemoError(403, `Role ${currentUser.role} cannot do this.`);
    }
    return state.ground as T;
  }

  if (method === 'POST' && path === '/api/governance/decide') {
    if (currentUser.role !== 'FLIGHT_SURGEON') {
      throw new DemoError(403, `Role ${currentUser.role} cannot do this.`);
    }
    const govId = String(b.govId ?? '');
    const decision = String(b.decision ?? '').toUpperCase().trim();
    if (!['APPROVED', 'REJECTED', 'DIRECTIVE_SENT'].includes(decision)) {
      throw new DemoError(400, 'decision must be APPROVED, REJECTED or DIRECTIVE_SENT.');
    }
    const directive = String(b.humanDirective ?? '').trim();
    if (decision === 'DIRECTIVE_SENT' && !directive) {
      throw new DemoError(400, 'A directive needs text.');
    }
    const item = state.ground.governance.find((g) => g.govId === govId);
    if (!item) throw new DemoError(400, `Review item ${govId} not found.`);
    const now = new Date().toISOString();
    item.status = decision;
    item.decidedBy = currentUser.display_name;
    item.decidedAtUtc = now;
    item.humanDirective = directive || null;
    item.delivery = 'DELIVERED';
    item.deliverAfterUtc = now;

    const crewState = state.crew[item.astronautId];
    if (crewState) {
      const updatedReview = {
        govId: item.govId,
        status: decision,
        label: REVIEW_LABELS[decision] ?? decision,
        riskTier: item.riskTier,
        actingAuthority: item.actingAuthority,
        sentToEarth: true,
        decidedBy: currentUser.display_name,
        decidedAtUtc: now,
        humanDirective: directive || null,
      };
      crewState.cards = crewState.cards.map((c) =>
        c.drawId === item.drawId || c.review?.govId === govId ? { ...c, review: updatedReview } : c,
      );
      if (crewState.latestDraw?.drawId === item.drawId) {
        crewState.review = updatedReview;
      }
    }
    saveState(state);
    return {
      govId,
      status: decision,
      packetId: `PKT-UP-${Date.now().toString(36)}`,
      deliverAfterUtc: now,
      queuedForBlackout: false,
    } as T;
  }

  throw new DemoError(404, `No endpoint ${method} ${path}.`);
}
