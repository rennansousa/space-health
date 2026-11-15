export type RiskTier = 'CRITICAL' | 'ATTENTION' | 'ROUTINE';
export type TriageTier = 'RED' | 'AMBER' | 'GREEN';
export type SystemId = 'neuro' | 'cardiovascular' | 'respiratory' | 'metabolic' | 'blood' | 'musculoskeletal';
export type Role = 'CREW' | 'CREW_MEDICAL_OFFICER' | 'FLIGHT_SURGEON';

export interface User {
  user_id: string;
  display_name: string;
  role: Role;
  mission_role: string;
  simulated: number;
}

export interface Source {
  label: string;
  url: string;
}

export interface Review {
  govId?: string;
  status: string;
  label: string;
  riskTier?: RiskTier;
  actingAuthority?: string;
  sentToEarth?: boolean;
  decidedBy?: string | null;
  decidedAtUtc?: string | null;
  humanDirective?: string | null;
}

export interface Card {
  cardId: string;
  drawId: string;
  drawLabel: string;
  analyte: string;
  label: string;
  system: SystemId | string;
  riskTier: RiskTier;
  headline: string;
  whatWeSaw: string;
  why: string;
  whatToDoNow: string[];
  whoDecides: string;
  sources: Source[];
  value: number;
  unit: string;
  status: string;
  artifactSuspected: boolean;
  review?: Review;
  stepsDone?: boolean[];
}

export interface Finding {
  analyte: string;
  label: string;
  system: string;
  value: number;
  unit: string;
  labRange: [number | null, number | null];
  baseline: { mean: number; n: number } | null;
  deltaVsBaselinePct: number | null;
  status: 'LOW' | 'HIGH' | 'IN_RANGE';
  baselineFlag: 'SHIFTED' | 'PERSONAL_NORMAL' | 'STABLE' | 'NO_BASELINE';
  redFlag: boolean;
  artifactSuspected: boolean;
  riskTier: RiskTier | null;
}

export interface Notice {
  drawLabel: string;
  analyte: string;
  label: string;
  direction: 'LOW' | 'HIGH';
  affected: string[];
  affectedValues: Record<string, number>;
  crewMeasured: number;
  text: string;
}

export interface LinkState {
  profile: string;
  label: string;
  blackout: boolean;
  oneWaySeconds: number;
  demoDelaySeconds: number;
  timeScale: string;
  profiles: Record<string, { label: string; oneWaySeconds: number }>;
}

export interface HistoryItem {
  drawId: string;
  label: string;
  missionDay: number;
  origin: string;
  simulated: boolean;
  score: number | null;
  note: string | null;
  measurements: number;
  outOfRange: number;
  cards: number;
  review: string | null;
  syncStatus: string;
  createdAtUtc?: string;
  findings?: Finding[];
}

export interface ManualSymptom {
  recordId: string;
  astronautId: string;
  displayName?: string;
  region: string;
  discomfortType: string;
  intensity: string;
  onset: string;
  duration: string;
  description: string;
  provenance: string;
  syncStatus?: string;
  createdAtUtc: string;
  receivedAtUtc?: string;
}

export interface Device {
  adapter: string;
  label: string;
  status: 'ACTIVE' | 'SIMULATED' | 'FUTURE';
  simulated: boolean;
  lastSeenUtc: string | null;
}

export interface CrewState {
  astronaut: { id: string; displayName: string; missionRole: string; simulated: boolean; xp: number };
  link: LinkState;
  lastSyncUtc: string | null;
  pendingUploadRecords: number;
  latestDraw: HistoryItem | null;
  review: Review;
  cards: Card[];
  notices: Notice[];
  systems: Record<SystemId, RiskTier | null>;
  progress: { done: number; total: number; pct: number };
  history: HistoryItem[];
  devices: Device[];
  sampleDraws: { label: string; loaded: boolean }[];
  crewList?: User[];
  vitals: { latest: VitalReading[]; news2: News2 | null };
  cabin: VitalReading[];
  trends: TrendWatch[];
  symptoms?: ManualSymptom[];
}

export interface VitalReading {
  type: string;
  label: string;
  value: number;
  unit: string;
  status: 'LOW' | 'HIGH' | 'IN_RANGE';
  normalRange: [number | null, number | null];
  rangeSource: string;
  measuredAtUtc: string;
  adapter: string;
}

export interface News2 {
  score: number;
  band: 'LOW' | 'LOW_MEDIUM' | 'MEDIUM' | 'HIGH';
  parameterScores: Record<string, number>;
  parametersUsed: string[];
  parametersMissing: string[];
  partial: boolean;
  source: { title: string; url: string };
}

export interface TrendWatch {
  analyte: string;
  label: string;
  unit: string;
  points: number;
  lastValue: number;
  slopePerWeek: number;
  rSquared: number;
  boundary: 'below' | 'above';
  limit: number;
  crossesInDays: number;
  horizonDays: number;
  text: string;
}

export interface DeviceKey {
  keyId: string;
  label: string;
  astronautId: string;
  adapter: string;
  createdBy: string;
  createdAtUtc: string;
  lastUsedAtUtc: string | null;
  uses: number;
  revoked: boolean;
}

export interface AssistantSource {
  ref: string;
  entryId: string;
  label: string;
  url: string;
}

export interface AssistantReply {
  question: string;
  mode: 'ANSWER' | 'EMERGENCY' | 'MEDICINE_REFUSED' | 'OUT_OF_SCOPE';
  engine: string;
  answer: string;
  steps?: string[];
  sources: AssistantSource[];
  guardrails: string[];
  topics?: string[];
  related?: string;
  disclaimer: string;
  alert?: { sent: boolean; demoDelaySeconds?: number; reason?: string };
  interpretedAs?: { entryId: string; title: string; by: string }[];
  alternatives?: { entryId: string; title: string }[];
}

export interface AssistantStatus {
  corpusEntries: number;
  model: string | null;
  llmReachable: boolean;
  modelInstalled: boolean;
  mode: 'extractive' | 'model';
  router: 'none' | 'ollama' | 'needle';
  rephrase: boolean;
  topics: { id: string; title: string; category: string }[];
}

export interface TriageRow {
  rowType: 'CREW' | 'NOTICE';
  rank: number;
  astronautId: string;
  displayName: string;
  simulated: boolean;
  tier: TriageTier;
  score: number | null;
  previousScore?: number | null;
  daysBetweenDraws?: number | null;
  dropPerDay?: number;
  urgency: number;
  lastDrawLabel?: string;
  lastReceivedUtc?: string | null;
  reasons: string[];
  trendWatch?: TrendWatch[];
  news2?: News2 | null;
}

export interface GovernanceItem {
  govId: string;
  drawId: string;
  astronautId: string;
  displayName: string;
  sourceExam: string;
  riskTier: RiskTier;
  actingAuthority: string;
  status: string;
  findings: Finding[];
  cards: Card[];
  decidedBy: string | null;
  humanDirective: string | null;
  decidedAtUtc: string | null;
  delivery: 'DELIVERED' | 'IN_TRANSIT' | 'QUEUED_BLACKOUT' | null;
  deliverAfterUtc: string | null;
  createdAtUtc: string;
  receivedAtUtc: string;
}

export interface GroundState {
  link: LinkState;
  triage: { formula: string; parameters: Record<string, number>; queue: TriageRow[] };
  governance: GovernanceItem[];
  recordsInTransit: number;
  syncLog: Record<string, string | number | null>[];
  symptoms?: ManualSymptom[];
  crewVitals?: Record<string, { latest: VitalReading[]; news2: News2 | null }>;
}
