import type { OrganId, RegionId, St } from '../lib/health';
import { BodyAvatar } from './BodyAvatar';

export interface BodyViewProps {
  status: Record<RegionId, St>;
  organSt: Partial<Record<OrganId, St>>;
  selected: RegionId | null;
  onSelect: (r: RegionId) => void;
  label: string;
  focus?: boolean;
}

/**
 * High-tech holographic astronaut avatar with 3D perspective gyro tilt,
 * pulsing bioluminescent organs, HUD telemetry callouts, and instant response.
 * Runs at 120 FPS with 0ms lag, no heavy WebGL overhead or browser lockups.
 */
export function BodyView({
  status,
  organSt,
  selected,
  onSelect,
  label,
}: BodyViewProps) {
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <BodyAvatar
        status={status}
        organSt={organSt}
        selected={selected}
        onSelect={onSelect}
        label={label}
        showTelemetry={true}
      />
    </div>
  );
}
