import { DateTime } from 'luxon';
import type { Observation } from '../monitor/observation.js';
import { activeQuietWindow, formatWindow, inViewingWindow, isWeekend, windowsFor, weekdayOf } from './schedule.js';
import type { Decision, Override, ReasonCode, Rules } from './types.js';

/**
 * The rules engine: a pure function of (observation, rules, today's usage, override, now).
 * No I/O, no clock — everything it needs is passed in, so it is exhaustively unit-testable.
 *
 * Priority (first match wins):
 *   pause override → allow everything
 *   lock override            → PowerOff
 *   quiet hours              → PowerOff   (any screen, including Home)
 *   outside viewing window   → PowerOff   (any screen, including Home)
 *   blocked app              → Home
 *   per-app budget exhausted → Home
 *   global budget exhausted  → Home
 * Home screen and screensaver are never subject to app rules; exempt apps skip app rules only.
 */

export interface UsageToday {
  /** Budgeted screen time today (kind=app, excluding usage.excludeAppIds). */
  screenMs: number;
  byApp: Record<string, number>;
}

export interface EngineInput {
  observation: Observation;
  rules: Rules;
  usage: UsageToday;
  override: Override | null;
  /** Bonus minutes granted for today; added to the global and every per-app budget. */
  bonusMinutes: number;
  now: number;
  zone: string;
}

const MIN = 60_000;

export function isOverrideActive(o: Override | null, now: number): o is Override {
  return o !== null && (o.until === null || o.until > now);
}

export function isAppBlocked(rules: Rules, appId: string): boolean {
  if (rules.exemptApps.includes(appId)) return false;
  const listed = rules.appPolicy.apps.includes(appId);
  return rules.appPolicy.mode === 'blocklist' ? listed : !listed;
}

/** Today's global budget in minutes for the local day of `local`, or null if unlimited. */
export function globalBudgetFor(rules: Rules, local: DateTime): number | null {
  return isWeekend(rules, local) ? rules.globalBudget.weekend : rules.globalBudget.weekday;
}

export function evaluate(input: EngineInput): Decision {
  const { observation: obs, rules, usage, override, bonusMinutes, now, zone } = input;
  const local = DateTime.fromMillis(now, { zone });
  const bonusMs = Math.max(0, bonusMinutes) * MIN;

  const watchingApp = obs.status === 'watching' && obs.kind === 'app' && obs.appId !== null;
  const appId = watchingApp ? obs.appId : null;
  const appName = obs.status === 'watching' ? obs.appName : null;

  // Remaining budgets (informational even when nothing is being enforced).
  const globalMin = globalBudgetFor(rules, local);
  const globalRemaining = globalMin === null ? null : Math.max(0, globalMin * MIN + bonusMs - usage.screenMs);
  const appMin = appId !== null && !rules.exemptApps.includes(appId) ? rules.appBudgets[appId] : undefined;
  const appRemaining = appMin === undefined ? null : Math.max(0, appMin * MIN + bonusMs - (usage.byApp[appId!] ?? 0));

  const quiet = activeQuietWindow(rules, local);
  const inWindow = inViewingWindow(rules, local);

  const base = {
    appId,
    appName,
    remainingMs: { global: globalRemaining, app: appRemaining },
    schedule: { inQuietHours: quiet !== null, inViewingWindow: inWindow },
  };
  const allow = (message: string, paused = false): Decision => ({
    ...base,
    action: 'none',
    reason: null,
    message,
    paused,
  });
  const act = (action: 'home' | 'power_off', reason: ReasonCode, message: string): Decision => ({
    ...base,
    action,
    reason,
    message,
    paused: false,
  });

  if (obs.status === 'unknown') return allow('TV state unknown');
  if (obs.status === 'off') return allow('TV is off');

  if (isOverrideActive(override, now)) {
    if (override.kind === 'pause') return allow(describeOverride(override, zone), true);
    return act('power_off', 'lock', describeOverride(override, zone));
  }

  if (quiet) return act('power_off', 'quiet_hours', `Quiet hours (${formatWindow(quiet)})`);

  if (inWindow === false) {
    const today = windowsFor(rules, weekdayOf(local)) ?? [];
    const allowed = today.length ? today.map(formatWindow).join(', ') : 'none today';
    return act('power_off', 'outside_window', `Outside viewing hours (allowed: ${allowed})`);
  }

  if (!watchingApp || appId === null) return allow(obs.kind === 'home' ? 'Home screen' : 'Screensaver');
  const label = appName ?? appId;
  if (rules.exemptApps.includes(appId)) return allow(`${label} is exempt`);

  if (isAppBlocked(rules, appId)) {
    return act(
      'home',
      'app_blocked',
      rules.appPolicy.mode === 'allowlist' ? `${label} is not on the allowed list` : `${label} is blocked`,
    );
  }
  if (appRemaining === 0) return act('home', 'app_budget', `${label}: daily limit of ${appMin} min reached`);
  if (globalRemaining === 0) return act('home', 'global_budget', `Daily screen-time limit of ${globalMin} min reached`);

  return allow(`${label} allowed`);
}

export function describeOverride(o: Override, zone: string): string {
  const until =
    o.until === null ? 'until turned off' : `until ${DateTime.fromMillis(o.until, { zone }).toFormat('h:mm a')}`;
  return o.kind === 'pause' ? `Enforcement paused ${until}` : `TV locked ${until}`;
}
