import { useEffect, useState } from 'react';
import { Organ } from '../components/Organ';
import { Icon, type IconName } from '../components/ui';
import { ApiError, apiGet, apiPost, getApiBase, saveSession, setApiBase } from '../lib/api';
import { useLang } from '../lib/i18n';
import type { User } from '../types';

// Demo sign-in: pick a person and enter. The server still issues a token per user; the demo PIN
// it publishes on GET /api/users is sent for you, so nobody has to type it.

const ROLE_ICON: Record<User['role'], IconName> = { CREW: 'user', CREW_MEDICAL_OFFICER: 'plus', FLIGHT_SURGEON: 'route' };

function initials(u: User): string {
  if (/^C\d{3}$/.test(u.user_id)) return u.user_id.replace(/^C0*/, 'C');
  const words = u.display_name.replace(/\(.*?\)/g, '').trim().split(/\s+/);
  return (words[0]?.[0] ?? '') + (words[1]?.[0] ?? '');
}

export function Login({ onSignedIn }: { onSignedIn: (u: User) => void }) {
  const { t } = useLang();
  const [users, setUsers] = useState<User[] | null>(null);
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [server, setServer] = useState(getApiBase());
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setUsers(null);
    setErr('');
    apiGet<{ users: User[]; demoPin: string }>('/api/users')
      .then((d) => {
        setUsers(d.users);
        setPin(d.demoPin);
      })
      .catch(() => {
        setUsers([]);
        setErr(t('cantReach'));
      });
  }, [server, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  async function enter(u: User) {
    setBusy(u.user_id);
    setErr('');
    try {
      const r = await apiPost<{ token: string; user: User }>('/api/login', { userId: u.user_id, pin });
      saveSession(r.token, r.user);
      onSignedIn(r.user);
    } catch (e) {
      const ae = e as ApiError;
      setErr(ae.status === 0 ? t('cantReach') : ae.message);
    } finally {
      setBusy(null);
    }
  }

  const groups: { title: string; people: User[] }[] = [
    { title: t('onBoard'), people: (users ?? []).filter((u) => u.role !== 'FLIGHT_SURGEON').sort((a, b) => a.simulated - b.simulated) },
    { title: t('onEarth'), people: (users ?? []).filter((u) => u.role === 'FLIGHT_SURGEON') },
  ];

  return (
    <main className="login">
      <div className="login-art" aria-hidden="true">
        <span className="l1"><Organ organ="coracao" mood="happy" size={64} /></span>
        <span className="l2"><Organ organ="pulmao" mood="happy" size={56} /></span>
        <span className="l3"><Organ organ="cerebro" mood="neutral" size={58} /></span>
        <span className="l4"><Organ organ="rins" mood="happy" size={52} /></span>
        <span className="l5"><Organ organ="figado" mood="neutral" size={56} /></span>
      </div>
      <section className="login-card" aria-labelledby="who">
        <div className="brand big">
          <img src="./icon.svg" alt="" width={48} height={48} />
          <span>SPACE HEALTH</span>
        </div>
        <h1 id="who" className="who-title">{t('whoSignsIn')}</h1>

        {users === null && <p className="muted sm">{t('loadingPeople')}</p>}

        {users && users.length > 0 && (
          <div className="people">
            {groups.map(
              (g) =>
                g.people.length > 0 && (
                  <div key={g.title} className="people-group" role="group" aria-label={g.title}>
                    <h2>{g.title}</h2>
                    {g.people.map((u) => (
                      <button key={u.user_id} type="button" className="person" onClick={() => enter(u)} disabled={busy !== null}>
                        <span className={`person-av r-${u.role}`} aria-hidden="true">
                          {u.role === 'CREW' ? initials(u) : <Icon name={ROLE_ICON[u.role]} size={20} />}
                        </span>
                        <span className="person-txt">
                          <strong>
                            {u.simulated ? u.display_name.replace(/\s*\(simulated\)/i, '') : u.display_name}
                            {u.simulated ? <span className="tag">{t('simulated')}</span> : null}
                          </strong>
                          <span>{u.mission_role}</span>
                        </span>
                        <span className="person-go" aria-hidden="true">
                          {busy === u.user_id ? '…' : <Icon name="chev" size={18} />}
                        </span>
                      </button>
                    ))}
                  </div>
                ),
            )}
          </div>
        )}

        {err && (
          <div className="row between">
            <p className="err" role="alert">{err}</p>
            {users?.length === 0 && (
              <button type="button" className="btn sm" onClick={() => setAttempt((n) => n + 1)}>
                {t('retry')}
              </button>
            )}
          </div>
        )}

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost sm" onClick={() => setSettings(!settings)} aria-expanded={settings}>
            <Icon name="gear" size={16} /> {t('settings')}
          </button>
        </div>
        {settings && (
          <label className="field">
            <span>{t('server')}</span>
            <input
              value={server}
              onChange={(e) => setServer(e.target.value)}
              onBlur={() => {
                setApiBase(server);
                setServer(getApiBase());
              }}
              placeholder="http://192.168.0.10:8000"
            />
          </label>
        )}
      </section>
    </main>
  );
}
