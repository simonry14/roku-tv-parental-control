import { DateTime } from 'luxon';
import type { Config } from '../config/schema.js';
import { openDatabase } from '../db/database.js';
import { createRepos, type Repos } from '../db/repo.js';
import { AuthService, PIN_PATTERN } from '../api/auth.js';
import { EcpClient } from '../ecp/client.js';
import { createCliLogger } from '../lib/logger.js';
import { formatDuration, formatLocal, localDayRange, systemClock } from '../lib/time.js';
import type { Observation } from '../monitor/observation.js';
import { describeOverride, evaluate, globalBudgetFor, isAppBlocked, isOverrideActive } from '../rules/engine.js';
import { formatWindow, nextScheduleChange } from '../rules/schedule.js';
import { WEEKDAYS, type Decision, type Rules } from '../rules/types.js';
import { UsageService, type UsageSummary } from '../usage/usage.js';
import { bold, c, dim, table } from './format.js';

/**
 * Parent controls from the PC (the dashboard does the same). They write to the same SQLite
 * database the service reads on every poll, so they take effect within one poll interval (~5 s).
 */

export function withRepos<T>(config: Config, fn: (repos: Repos) => T): T {
  const db = openDatabase(config.database.path, { logger: createCliLogger() });
  try {
    return fn(createRepos(db));
  } finally {
    db.close();
  }
}

function parseMinutes(arg: string | undefined, command: string, required = false): number | null {
  if (arg === undefined) {
    if (required) throw new Error(`Usage: npm run ${command} -- <minutes>`);
    return null;
  }
  const n = Number(arg);
  if (!Number.isFinite(n) || n === 0 || Math.abs(n) > 24 * 60)
    throw new Error(`"${arg}" is not a valid number of minutes`);
  return Math.round(n);
}

export function pinnedAddress(config: Config, repos: Repos): { host: string; port: number } | null {
  const pinned = config.device.serial ? repos.devices.get(config.device.serial) : repos.devices.pinned();
  const host = config.device.host ?? pinned?.host;
  if (!host) return null;
  return { host, port: config.device.host ? config.device.port : (pinned?.port ?? config.device.port) };
}

export function pauseCommand(config: Config, arg: string | undefined): void {
  const minutes = parseMinutes(arg, 'pause');
  const now = Date.now();
  const until = minutes === null ? null : now + minutes * 60_000;
  withRepos(config, (r) => {
    r.overrides.set({ kind: 'pause', until, setAt: now, note: null });
    r.events.add({
      at: now,
      type: 'override',
      severity: 'info',
      message: describeOverride({ kind: 'pause', until, setAt: now, note: null }, config.timezone),
    });
  });
  console.log(
    `${c('green', '⏸')}  ${describeOverride({ kind: 'pause', until, setAt: now, note: null }, config.timezone)}.`,
  );
  console.log(dim('   Resume with: npm run resume'));
}

export function resumeCommand(config: Config): void {
  const now = Date.now();
  const cleared = withRepos(config, (r) => {
    const before = r.overrides.get();
    const ok = r.overrides.clear();
    if (ok)
      r.events.add({ at: now, type: 'override', severity: 'info', message: `Override cleared (${before?.kind})` });
    return ok ? before : null;
  });
  console.log(
    cleared
      ? `${c('green', '▶')}  ${cleared.kind === 'lock' ? 'TV unlocked' : 'Enforcement resumed'} — normal rules apply.`
      : 'No pause or lock was active.',
  );
}

export async function lockCommand(config: Config, arg: string | undefined): Promise<void> {
  const minutes = parseMinutes(arg, 'lock');
  const now = Date.now();
  const until = minutes === null ? null : now + minutes * 60_000;
  const address = withRepos(config, (r) => {
    r.overrides.set({ kind: 'lock', until, setAt: now, note: null });
    r.events.add({
      at: now,
      type: 'override',
      severity: 'warn',
      message: describeOverride({ kind: 'lock', until, setAt: now, note: null }, config.timezone),
    });
    return pinnedAddress(config, r);
  });
  console.log(
    `${c('red', '🔒')} ${describeOverride({ kind: 'lock', until, setAt: now, note: null }, config.timezone)}.`,
  );
  // A parent's explicit "lock now" acts immediately, even in dry-run.
  if (address) {
    try {
      await new EcpClient({ ...address, timeoutMs: config.monitor.requestTimeoutMs }).keypress('PowerOff');
      console.log(dim('   Sent PowerOff to the TV.'));
    } catch (err) {
      console.log(c('yellow', `   Could not send PowerOff now: ${(err as Error).message}`));
    }
  }
  if (config.enforcement.mode !== 'enforce') {
    console.log(
      c(
        'yellow',
        `   Note: enforcement is "${config.enforcement.mode}", so the service won't turn the TV off again if it's switched back on.`,
      ),
    );
  }
  console.log(dim('   Unlock with: npm run unlock'));
}

export async function setPinCommand(config: Config, pin: string | undefined): Promise<void> {
  if (!pin || !PIN_PATTERN.test(pin)) {
    throw new Error('Usage: npm run set-pin -- <4-12 digits>   (6+ digits recommended)');
  }
  const db = openDatabase(config.database.path, { logger: createCliLogger() });
  try {
    const repos = createRepos(db);
    const auth = new AuthService(db, repos.settings, { sessionDays: config.http.sessionDays }, systemClock);
    const replaced = auth.isPinSet();
    await auth.setPin(pin);
    repos.events.add({
      at: Date.now(),
      type: 'auth',
      severity: 'warn',
      message: replaced ? 'Dashboard PIN changed (CLI)' : 'Dashboard PIN set (CLI)',
    });
    console.log(`${c('green', '✓')} Dashboard PIN ${replaced ? 'changed — all devices were signed out' : 'set'}.`);
  } finally {
    db.close();
  }
}

export function bonusCommand(config: Config, arg: string | undefined): void {
  const minutes = parseMinutes(arg, 'bonus', true)!;
  const now = Date.now();
  const day = localDayRange(now, config.timezone).day;
  const total = withRepos(config, (r) => {
    const t = r.overrides.addBonus(day, minutes, now);
    r.events.add({
      at: now,
      type: 'override',
      severity: 'info',
      message: `Bonus ${minutes > 0 ? '+' : ''}${minutes} min (today: ${t} min)`,
    });
    return t;
  });
  console.log(`${c('green', '⏱')}  Bonus time today: ${bold(`${total} min`)} (added to the daily and per-app limits).`);
}

export async function appsCommand(config: Config, json: boolean): Promise<void> {
  const now = Date.now();
  const { apps, usage, address } = withRepos(config, (r) => {
    const today = new UsageService(r.sessions, config.timezone, config.usage.excludeAppIds).forDay(now);
    const byApp = new Map(today.byApp.map((a) => [a.appId, a.ms]));
    return { apps: r.apps.list({ installedOnly: true }), usage: byApp, address: pinnedAddress(config, r) };
  });

  let list = apps.map((a) => ({ id: a.appId, name: a.name, type: a.type }));
  if (!list.length && address) {
    try {
      list = (await new EcpClient({ ...address, timeoutMs: config.monitor.requestTimeoutMs }).apps()).map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
      }));
    } catch (err) {
      console.error(c('yellow', `Could not list apps from the TV: ${(err as Error).message}`));
    }
  }
  const rules = config.rules;
  const rows = list.map((a) => ({ ...a, rule: ruleFor(rules, a.id), todayMs: usage.get(a.id) ?? 0 }));
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (!rows.length) {
    console.log(dim('No apps known yet — start the service once (npm run dev) so it can read the TV’s app list.'));
    return;
  }
  console.log(
    table(
      ['Id', 'Name', 'Type', 'Rule', 'Today'],
      rows.map((a) => [bold(a.id), a.name, a.type ?? '', a.rule, a.todayMs ? formatDuration(a.todayMs) : '']),
    ),
  );
  console.log(
    dim('\nUse the Id in config.json → rules.appPolicy.apps / rules.appBudgets. TV inputs (tvinput.*) are apps too.'),
  );
}

function ruleFor(rules: Rules, id: string): string {
  if (rules.exemptApps.includes(id)) return dim('exempt');
  if (isAppBlocked(rules, id)) return c('red', rules.appPolicy.mode === 'allowlist' ? 'not allowed' : 'blocked');
  const budget = rules.appBudgets[id];
  return budget !== undefined ? c('yellow', `${budget} min/day`) : dim('allowed');
}

export function eventsCommand(config: Config, opts: { limit: number; type?: string; json: boolean }): void {
  const events = withRepos(config, (r) =>
    r.events.recent({ limit: opts.limit, ...(opts.type ? { type: opts.type } : {}) }),
  );
  if (opts.json) {
    console.log(JSON.stringify(events, null, 2));
    return;
  }
  if (!events.length) {
    console.log(dim('No events yet.'));
    return;
  }
  const sev: Record<string, Parameters<typeof c>[0]> = { error: 'red', warn: 'yellow', info: 'white', debug: 'gray' };
  console.log(
    table(
      ['Time', 'Type', 'Event'],
      events.map((e) => [
        dim(formatLocal(e.at, config.timezone, 'LLL d h:mm:ss a')),
        e.type,
        c(sev[e.severity] ?? 'white', e.message),
      ]),
    ),
  );
}

// ─── Rules section for `status` ─────────────────────────────────────────────

export function describeRules(rules: Rules): string[] {
  const parts: string[] = [];
  const { appPolicy } = rules;
  if (appPolicy.mode === 'allowlist') parts.push(`allowlist (${appPolicy.apps.length} apps)`);
  else if (appPolicy.apps.length)
    parts.push(`${appPolicy.apps.length} blocked app${appPolicy.apps.length > 1 ? 's' : ''}`);
  const budgets = Object.keys(rules.appBudgets).length;
  if (budgets) parts.push(`${budgets} app limit${budgets > 1 ? 's' : ''}`);
  const g = rules.globalBudget;
  if (g.weekday !== null || g.weekend !== null)
    parts.push(`daily limit ${g.weekday ?? '∞'}/${g.weekend ?? '∞'} min (weekday/weekend)`);
  if (rules.viewingWindows) {
    const days = WEEKDAYS.filter((d) => rules.viewingWindows?.[d] != null).length;
    parts.push(`viewing windows (${days} day${days === 1 ? '' : 's'})`);
  }
  if (rules.quietHours.length) parts.push(`quiet hours ${rules.quietHours.map(formatWindow).join(', ')}`);
  return parts;
}

export interface RulesView {
  rows: Array<[string, string]>;
  decision: Decision;
}

export function rulesView(
  config: Config,
  input: {
    observation: Observation;
    usage: UsageSummary;
    override: ReturnType<Repos['overrides']['get']>;
    bonus: number;
    now: number;
  },
): RulesView {
  const { rules, enforcement, timezone: zone } = config;
  const { observation, usage, override, bonus, now } = input;
  const decision = evaluate({
    observation,
    rules,
    usage: { screenMs: usage.screenMs, byApp: Object.fromEntries(usage.byApp.map((a) => [a.appId, a.ms])) },
    override,
    bonusMinutes: bonus,
    now,
    zone,
  });
  const rows: Array<[string, string]> = [];
  const modeLabel =
    enforcement.mode === 'enforce'
      ? c('green', 'ENFORCING')
      : enforcement.mode === 'dry-run'
        ? c('yellow', 'PRACTICE MODE')
        : c('gray', 'OFF');
  const summary = describeRules(rules);
  rows.push([
    'Rules',
    `${modeLabel}  ${summary.length ? summary.join(' · ') : dim('no rules configured (monitoring only)')}`,
  ]);
  if (isOverrideActive(override, now))
    rows.push(['Override', c(override.kind === 'lock' ? 'red' : 'yellow', describeOverride(override, zone))]);

  if (decision.action !== 'none') {
    const verb = decision.action === 'home' ? 'Home' : 'PowerOff';
    const prefix = enforcement.mode === 'enforce' ? `→ ${verb}` : `would send ${verb}`;
    rows.push(['Now', c('red', `${prefix} — ${decision.message}`)]);
  } else if (observation.status === 'watching') {
    rows.push(['Now', c('green', `✓ ${decision.message}`)]);
  }

  const local = DateTime.fromMillis(now, { zone });
  const globalMin = globalBudgetFor(rules, local);
  const remaining: string[] = [];
  if (globalMin !== null) {
    const left = decision.remainingMs.global ?? Math.max(0, (globalMin + bonus) * 60_000 - usage.screenMs);
    remaining.push(`today ${bold(formatDuration(left))} left of ${globalMin} min${bonus ? ` (+${bonus} bonus)` : ''}`);
  } else if (bonus) {
    remaining.push(`bonus today +${bonus} min`);
  }
  if (decision.remainingMs.app !== null && decision.appName)
    remaining.push(`${decision.appName} ${formatDuration(decision.remainingMs.app)} left`);
  if (remaining.length) rows.push(['Remaining', remaining.join(' · ')]);

  const next = nextScheduleChange(rules, now, zone);
  if (next) rows.push(['Next', `${next.label} at ${formatLocal(next.at, zone, 'ccc h:mm a')}`]);
  return { rows, decision };
}
