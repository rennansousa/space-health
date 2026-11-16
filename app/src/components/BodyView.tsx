import { lazy, Suspense, useState } from 'react';
import type { OrganId, RegionId, St } from '../lib/health';
import { BodyAvatar } from './BodyAvatar';

const Body3D = lazy(() => import('./Body3D'));

function webgl(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

/** Holographic 2D body by default (instant, zero WebGL overhead), with an optional 3D toggle when WebGL is available. */
export function BodyView(p: { status: Record<RegionId, St>; organSt: Partial<Record<OrganId, St>>; selected: RegionId | null; onSelect: (r: RegionId) => void; label: string; focus?: boolean }) {
  const [gl] = useState(webgl);
  const [mode3d, setMode3d] = useState(false);
  const flat = <BodyAvatar status={p.status} selected={p.selected} onSelect={p.onSelect} label={p.label} />;
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {mode3d && gl ? (
        <Suspense fallback={flat}>
          <Body3D {...p} />
        </Suspense>
      ) : (
        flat
      )}
      {gl && (
        <button
          type="button"
          onClick={() => setMode3d((v) => !v)}
          aria-pressed={mode3d}
          style={{
            position: 'absolute',
            top: 10,
            right: 10,
            zIndex: 4,
            minHeight: 28,
            padding: '4px 10px',
            borderRadius: 999,
            background: 'rgba(255, 255, 255, 0.14)',
            color: '#dbe6ff',
            fontSize: 11.5,
            fontWeight: 700,
            backdropFilter: 'blur(6px)',
          }}
        >
          {mode3d ? '2D' : '3D'}
        </button>
      )}
    </div>
  );
}
