import type { ActiveApp } from '../ecp/types.js';
import type { SessionKind } from '../db/repo.js';

/**
 * What one poll saw. The session tracker and (Phase 2) rules engine consume these.
 *   - watching: screen is on and we know what's on it
 *   - off:      TV answered, power-mode ≠ PowerOn
 *   - unknown:  we could not observe (unreachable, or ECP queries refused)
 */
export type Observation =
  | {
      status: 'watching';
      deviceSerial: string;
      kind: SessionKind;
      appId: string | null;
      appName: string;
      appType: string | null;
    }
  | { status: 'off'; deviceSerial: string; powerMode: string | null }
  | { status: 'unknown'; reason: 'unreachable' | 'restricted' };

export type WatchingObservation = Extract<Observation, { status: 'watching' }>;

export const HOME_NAME = 'Home';

/** Map /query/active-app to an activity. A screensaver wins over whatever is underneath it. */
export function classifyActiveApp(active: ActiveApp, deviceSerial: string): WatchingObservation {
  if (active.screensaver) {
    return {
      status: 'watching',
      deviceSerial,
      kind: 'screensaver',
      appId: active.screensaver.id || null,
      appName: active.screensaver.name || 'Screensaver',
      appType: active.screensaver.type,
    };
  }
  if (!active.app) {
    return { status: 'watching', deviceSerial, kind: 'home', appId: null, appName: HOME_NAME, appType: null };
  }
  return {
    status: 'watching',
    deviceSerial,
    kind: 'app',
    appId: active.app.id,
    appName: active.app.name || active.app.id,
    appType: active.app.type,
  };
}
