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

/** 3D body when the device has WebGL (loaded on demand), the 2D drawing otherwise and while it loads. */
export function BodyView(p: { status: Record<RegionId, St>; organSt: Partial<Record<OrganId, St>>; selected: RegionId | null; onSelect: (r: RegionId) => void; label: string; focus?: boolean }) {
  const [gl] = useState(webgl);
  const flat = <BodyAvatar status={p.status} selected={p.selected} onSelect={p.onSelect} label={p.label} />;
  if (!gl) return flat;
  return (
    <Suspense fallback={flat}>
      <Body3D {...p} />
    </Suspense>
  );
}
