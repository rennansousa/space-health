import { useCallback, useEffect, useState } from 'react';
import { clearSession, getUser } from './lib/api';
import type { User } from './types';
import { Crew } from './views/Crew';
import { Ground } from './views/Ground';
import { Login } from './views/Login';
import { Watch } from './views/Watch';

// Routes: #/ (login → by role), #/crew, #/ground, #/watch (smartwatch face for a crew session)
function route(): string {
  return window.location.hash.replace(/^#\/?/, '') || '';
}

export function App() {
  const [user, setUser] = useState<User | null>(getUser());
  const [r, setR] = useState(route());
  useEffect(() => {
    const f = () => setR(route());
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);

  const signOut = useCallback(() => {
    clearSession();
    setUser(null);
  }, []);

  if (!user) return <Login onSignedIn={(u) => { setUser(u); if (r !== 'watch') window.location.hash = u.role === 'FLIGHT_SURGEON' ? '#/ground' : '#/crew'; }} />;
  if (user.role === 'FLIGHT_SURGEON') return <Ground user={user} onSignOut={signOut} />;
  if (r === 'watch') return <Watch onSignOut={signOut} />;
  return <Crew user={user} onSignOut={signOut} />;
}
