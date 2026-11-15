export type Lang = 'en';

const en = {
  health: 'Health', mission: 'Mission', signOut: 'Sign out', close: 'Close', back: 'Back', send: 'Send', cancel: 'Cancel', save: 'Save',
  loading: 'Loading…', retry: 'Try again', now: 'now', never: 'never',
  synced: 'Synced', offline: 'Offline · on-board data', blackout: 'No link with Earth', waiting: 'to send', syncNow: 'Sync now',
  syncSent: 'Sent to Earth. Arrives in', syncNoLink: 'No link right now. Records stay safe on board.',
  'st.ok': 'In range', 'st.att': 'Attention', 'st.crit': 'Act now', 'st.none': 'No data',
  coracao: 'Heart', pulmao: 'Lungs', cerebro: 'Brain', rins: 'Kidneys', figado: 'Liver',
  head: 'Head', chest: 'Chest', abdomen: 'Abdomen', armL: 'Left arm', armR: 'Right arm', legL: 'Left leg', legR: 'Right leg',
  // login
  loginTitle: 'Sign in', userId: 'User ID', pin: 'PIN', enter: 'Enter', server: 'Ship server', wrongPin: 'Wrong user or PIN.',
  cantReach: "Can't reach the ship server.", settings: 'Settings', whoSignsIn: 'Who is signing in?', onBoard: 'On board', onEarth: 'On Earth', simulated: 'Simulated', loadingPeople: 'Loading crew list…',
  // health
  guidance: 'Guidance', newGuidance: 'new', body: 'Body', companion: 'Companion', race: 'Organ race',
  lastReading: 'Last reading', source: 'Source', range: 'Range', yourNormal: 'Your normal', noRecords: 'No records yet.',
  askAbout: 'Ask about this', values: 'Values', tapAgain: 'Tap again for details',
  // orientations
  newTab: 'New', historyTab: 'History', whatHappened: 'What happened', whyMatters: 'Why it matters', evidence: 'Data behind it',
  whatToDo: 'What you can do', whoDecides: 'Who decides', acknowledge: 'Got it', acknowledged: 'Acknowledged', sources: 'Sources',
  directive: 'Directive from Earth', confirmed: 'Confirmed by Earth', allClear: 'Nothing new.',
  all: 'All', exams: 'Exams', symptoms: 'Symptoms', decisions: 'Decisions', actions: 'Actions', signals: 'Signals',
  pendingSync: 'not synced yet',
  // body + symptoms
  bodyTitle: 'Your body', reportSymptom: 'Report a symptom', reported: 'Reported by you', nothingHere: 'Nothing recorded here.',
  front: 'Front', symptomTitle: 'How do you feel?', where: 'Where', what: 'What', howStrong: 'How strong', since: 'Since', howLong: 'How long', notes: 'Notes (optional)',
  'sym.pain': 'Pain', 'sym.pressure': 'Pressure', 'sym.nausea': 'Nausea', 'sym.dizzy': 'Dizziness', 'sym.numb': 'Numbness', 'sym.tired': 'Fatigue', 'sym.other': 'Other',
  mild: 'Mild', moderate: 'Moderate', severe: 'Severe',
  'on.now': 'Now', 'on.1h': '< 1 h', 'on.today': 'Today', 'on.yday': 'Yesterday',
  'du.ongoing': 'Ongoing', 'du.min': 'Minutes', 'du.hours': 'Hours', 'du.days': 'Days',
  saved: 'Saved to your record.', savedOffline: 'Saved on this device. It will be sent when the server is back.',
  // mission
  activities: 'Activities', equipment: 'Equipment', stepsDone: 'steps done', nextUp: 'Next', done: 'Done', nothingToDo: 'No pending activities.',
  'dev.ACTIVE': 'Connected', 'dev.SIMULATED': 'Simulated', 'dev.FUTURE': 'Not connected', lastSeen: 'Last data', addExam: 'Add exam',
  review: 'Review',
  // companion
  hi: 'Hi! Ask me anything about your health or the mission.', hiCard: 'You opened', placeholder: 'Ask something…',
  helpNow: 'I need help now', topics: 'Tap a topic', understood: 'Understood as', thinking: 'Checking…', assistantOff: "I can't reach the assistant right now.",
  whyThis: 'Why did I get this?', whatNow: 'What can I do now?',
  // ground
  ground: 'Mission control', crew: 'Crew', score: 'Score', reasons: 'Reasons', reviewQueue: 'Review', approve: 'Approve', reject: 'Reject',
  sendDirective: 'Send directive', directivePh: 'Directive for the crew…', finding: 'Finding', value: 'Value', delta: 'vs normal',
  noReview: 'Nothing to review for this crew member.', inTransit: 'in transit', decided: 'Decided', status: 'Status', selectCrew: 'Select a crew member',
  // watch
  tapOrgan: 'Tap to hear an organ',
  dragToRotate: 'Drag to rotate', details: 'Details',
};

export type Key = keyof typeof en;

/** The interface is English only. `lang` stays in the API so callers keep one shape. */
export function useLang(): { lang: Lang; t: (k: Key) => string } {
  return { lang: 'en', t: (k: Key) => en[k] };
}

export function ago(iso: string | null | undefined, _lang?: Lang): string {
  if (!iso) return en.never;
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return en.now;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

export function clock(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}
