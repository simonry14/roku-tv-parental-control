import { DateTime } from 'luxon';
import type { Guardian } from '../app.js';
import { localDayRange } from '../lib/time.js';
import type { Observation } from '../monitor/observation.js';
import { describeOverride, evaluate, globalBudgetFor, isAppBlocked, isOverrideActive } from '../rules/engine.js';
import { nextScheduleChange } from '../rules/schedule.js';
import type { AppDto, DayUsageDto, StatusDto } from './contract.js';

const MIN = 60_000;

export const iconUrl = (appId: string): string => `/api/apps/${encodeURIComponent(appId)}/icon`;

/** Everything the dashboard's live view needs, in one object. */
export function buildStatus(g: Guardian, now = g.clock.now()): StatusDto {
  const { runtime, repos, poller, usage } = g;
  const zone = g.config.timezone;
  const live = poller.getStatus();
  const rules = runtime.rules;
  const today = usage.forDay(now);
  const bonus = repos.overrides.bonusFor(today.range.day);
  const override = repos.overrides.get();
  const local = DateTime.fromMillis(now, { zone });

  // Re-evaluate on the latest known activity so the view is consistent with what's on screen now.
  const observation: Observation = live.activity
    ? {
        status: 'watching',
        deviceSerial: live.device?.serial ?? '',
        kind: live.activity.kind,
        appId: live.activity.appId,
        appName: live.activity.appName,
        appType: null,
      }
    : live.health === 'tv_off'
      ? { status: 'off', deviceSerial: live.device?.serial ?? '', powerMode: live.powerMode }
      : { status: 'unknown', reason: live.health === 'restricted' ? 'restricted' : 'unreachable' };
  const decision = evaluate({
    observation,
    rules,
    usage: { screenMs: today.screenMs, byApp: Object.fromEntries(today.byApp.map((a) => [a.appId, a.ms])) },
    override,
    bonusMinutes: bonus,
    now,
    zone,
  });

  const globalMin = globalBudgetFor(rules, local);
  const budgetMs = globalMin === null ? null : (globalMin + bonus) * MIN;
  const lastEnf = repos.events.recent({ type: 'enforcement', limit: 1 })[0];

  return {
    now,
    timezone: zone,
    version: g.version,
    health: {
      state: live.health,
      restriction: live.restriction,
      message: live.message,
      since: live.healthSince,
      lastError: live.lastError,
      lastPollAt: live.lastPollAt,
    },
    tv: live.device ? { ...live.device, power: live.powerMode } : null,
    current: live.activity
      ? {
          ...live.activity,
          iconUrl: live.activity.appId && live.activity.kind === 'app' ? iconUrl(live.activity.appId) : null,
        }
      : null,
    today: {
      day: today.range.day,
      screenMs: today.screenMs,
      homeMs: today.homeMs,
      budgetMs,
      remainingMs: budgetMs === null ? null : Math.max(0, budgetMs - today.screenMs),
      bonusMinutes: bonus,
      byApp: today.byApp.map((a) => {
        const min = rules.appBudgets[a.appId];
        const appBudget = min === undefined ? null : (min + bonus) * MIN;
        return {
          appId: a.appId,
          appName: a.appName,
          ms: a.ms,
          budgetMs: appBudget,
          remainingMs: appBudget === null ? null : Math.max(0, appBudget - a.ms),
          iconUrl: iconUrl(a.appId),
        };
      }),
    },
    decision: { action: decision.action, reason: decision.reason, message: decision.message, paused: decision.paused },
    enforcement: { mode: runtime.enforcement.mode },
    override: isOverrideActive(override, now) ? { ...override, message: describeOverride(override, zone) } : null,
    schedule: decision.schedule,
    nextChange: nextScheduleChange(rules, now, zone),
    lastEnforcement: lastEnf ? { at: lastEnf.at, message: lastEnf.message } : null,
    tvMessages: {
      enabled: runtime.tvMessages.enabled,
      installed: g.enforcer.tv.installed(),
      showing: live.activity?.kind === 'app' && live.activity.appId === runtime.tvMessages.appId,
      countdown: (() => {
        const c = g.enforcer.getCountdown();
        return c && c.endsAt > now ? { endsAt: c.endsAt, title: c.title, reason: c.reason } : null;
      })(),
    },
  };
}

export function buildApps(g: Guardian, now = g.clock.now()): AppDto[] {
  const rules = g.runtime.rules;
  const today = new Map(g.usage.forDay(now).byApp.map((a) => [a.appId, a.ms]));
  const channelId = g.runtime.tvMessages.appId;
  return g.repos.apps
    .list({ installedOnly: true })
    .filter((a) => a.appId !== channelId)
    .map((a) => ({
      appId: a.appId,
      name: a.name,
      type: a.type,
      iconUrl: iconUrl(a.appId),
      rule: rules.exemptApps.includes(a.appId) ? 'exempt' : isAppBlocked(rules, a.appId) ? 'blocked' : 'allowed',
      budgetMinutes: rules.appBudgets[a.appId] ?? null,
      todayMs: today.get(a.appId) ?? 0,
    }));
}

export function buildUsageDays(g: Guardian, days: number, now = g.clock.now()): DayUsageDto[] {
  const zone = g.config.timezone;
  const out: DayUsageDto[] = [];
  const todayStart = DateTime.fromMillis(localDayRange(now, zone).start, { zone });
  for (let i = days - 1; i >= 0; i--) {
    const d = todayStart.minus({ days: i });
    const u = g.usage.forDay(d.toMillis());
    out.push({
      day: u.range.day,
      weekday: (['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const)[d.weekday - 1]!,
      screenMs: u.screenMs,
      homeMs: u.homeMs,
      byApp: u.byApp.map(({ appId, appName, ms }) => ({ appId, appName, ms })),
    });
  }
  return out;
}
