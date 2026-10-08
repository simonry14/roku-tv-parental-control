import type { SessionKind, SessionRecord } from '../db/repo.js';
import type { Observation } from './observation.js';

/**
 * Connection health, surfaced prominently on the dashboard.
 *   starting   service just started, first poll pending
 *   searching  no TV located yet (never pinned, or discovery failing with no known address)
 *   online     reachable, screen on
 *   tv_off     reachable, power-mode ≠ PowerOn (standby with Fast TV start)
 *   offline    not answering (fully powered down, unplugged, Wi-Fi down, or moved)
 *   restricted TV reachable but ECP refuses us — see `restriction`
 */
export type Health = 'starting' | 'searching' | 'online' | 'tv_off' | 'offline' | 'restricted';

/**
 *   limited   queries work but control is refused (HTTP 403 on keypress/icon) — "Limited" mode
 *   blocked   queries refused with HTTP 401/403 — what a real Roku TV does when the setting is Disabled
 *   disabled  connection refused on port 8060 while the host is present on the LAN
 */
export type Restriction = 'limited' | 'blocked' | 'disabled';

export interface LiveStatus {
  health: Health;
  healthSince: number;
  restriction: Restriction | null;
  message: string;
  device: { serial: string; name: string; model: string | null; host: string; port: number } | null;
  powerMode: string | null;
  activity: { kind: SessionKind; appId: string | null; appName: string; since: number } | null;
  lastPollAt: number | null;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
  pollIntervalMs: number;
  lastError: string | null;
}

export const SETTINGS_HINT =
  'On the TV: Settings → System → Advanced system settings → Control by mobile apps → Network access → Enabled.';

export function healthMessage(health: Health, restriction: Restriction | null): string {
  switch (health) {
    case 'starting':
      return 'Starting…';
    case 'searching':
      return 'Looking for the TV on the network…';
    case 'online':
      return 'Connected — TV is on';
    case 'tv_off':
      return 'Connected — TV is off (standby)';
    case 'offline':
      return 'TV unreachable — fully powered off, unplugged, Wi-Fi down, or its address changed';
    case 'restricted':
      switch (restriction) {
        case 'limited':
          return `ECP is in Limited mode: monitoring works but enforcement is BLOCKED. ${SETTINGS_HINT}`;
        case 'blocked':
          return `ECP access denied (HTTP 403): Control by mobile apps is set to Disabled (or Limited) on the TV. ${SETTINGS_HINT}`;
        case 'disabled':
        default:
          return `ECP disabled: the TV is on the network but refuses control connections. ${SETTINGS_HINT}`;
      }
  }
}

export const healthSeverity = (h: Health): 'info' | 'warn' | 'error' =>
  h === 'restricted' ? 'error' : h === 'offline' || h === 'searching' ? 'warn' : 'info';

// ─── Bus event payloads ─────────────────────────────────────────────────────

export interface ObservationEvent {
  at: number;
  observation: Observation;
  status: LiveStatus;
}

export interface HealthChangeEvent {
  at: number;
  from: Health;
  to: Health;
  restriction: Restriction | null;
  message: string;
}

export interface SessionChangeEvent {
  at: number;
  closed: SessionRecord[];
  opened: SessionRecord | null;
}

export interface DeviceChangeEvent {
  at: number;
  device: NonNullable<LiveStatus['device']>;
  via: string;
}
