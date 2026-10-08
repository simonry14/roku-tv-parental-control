import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { RulesConfigSchema } from '../../src/config/rules-schema.js';
import type { Observation } from '../../src/monitor/observation.js';
import { evaluate, type EngineInput } from '../../src/rules/engine.js';
import { nextScheduleChange, parseWindow } from '../../src/rules/schedule.js';
import type { Override } from '../../src/rules/types.js';
import { MIN } from '../helpers.js';

const TZ = 'America/New_York';
const at = (iso: string): number => DateTime.fromISO(iso, { zone: TZ }).toMillis();
const R = (input: unknown = {}) => RulesConfigSchema.parse(input);

const app = (id: string, name = id): Observation => ({
  status: 'watching',
  deviceSerial: 'TV',
  kind: 'app',
  appId: id,
  appName: name,
  appType: id.startsWith('tvinput.') ? 'tvin' : 'appl',
});
const home: Observation = {
  status: 'watching',
  deviceSerial: 'TV',
  kind: 'home',
  appId: null,
  appName: 'Home',
  appType: null,
};
const saver: Observation = {
  status: 'watching',
  deviceSerial: 'TV',
  kind: 'screensaver',
  appId: '5',
  appName: 'Aquarium',
  appType: 'ssvr',
};
const off: Observation = { status: 'off', deviceSerial: 'TV', powerMode: 'DisplayOff' };

// 2026-09-30 is a Wednesday; 2026-10-03 a Saturday.
const WED_4PM = '2026-09-30T16:00';

function run(over: Partial<EngineInput> = {}) {
  return evaluate({
    observation: app('12', 'Netflix'),
    rules: R(),
    usage: { screenMs: 0, byApp: {} },
    override: null,
    bonusMinutes: 0,
    now: at(WED_4PM),
    zone: TZ,
    ...over,
  });
}

const pause = (until: number | null): Override => ({ kind: 'pause', until, setAt: 0, note: null });
const lock = (until: number | null): Override => ({ kind: 'lock', until, setAt: 0, note: null });

describe('app policy', () => {
  it('no rules = everything allowed, budgets unlimited', () => {
    const d = run();
    expect(d).toMatchObject({ action: 'none', reason: null, remainingMs: { global: null, app: null } });
    expect(d.schedule).toEqual({ inQuietHours: false, inViewingWindow: null });
  });

  it('blocklist blocks listed apps only', () => {
    const rules = R({ appPolicy: { mode: 'blocklist', apps: ['12'] } });
    expect(run({ rules })).toMatchObject({ action: 'home', reason: 'app_blocked', message: 'Netflix is blocked' });
    expect(run({ rules, observation: app('837', 'YouTube') }).action).toBe('none');
  });

  it('allowlist blocks everything not listed, including TV inputs; exempt apps pass', () => {
    const rules = R({ appPolicy: { mode: 'allowlist', apps: ['23333'] } });
    expect(run({ rules, observation: app('23333', 'PBS KIDS') }).action).toBe('none');
    expect(run({ rules, observation: app('tvinput.hdmi1', 'Game console') })).toMatchObject({
      action: 'home',
      reason: 'app_blocked',
      message: 'Game console is not on the allowed list',
    });
    expect(run({ rules, observation: app('dev', "Time's up") }).action).toBe('none');
  });

  it('never applies app rules to Home or the screensaver', () => {
    const rules = R({ appPolicy: { mode: 'allowlist', apps: [] }, globalBudget: 0 });
    expect(run({ rules, observation: home }).action).toBe('none');
    expect(run({ rules, observation: saver }).action).toBe('none');
  });

  it('does nothing when the TV is off or unobservable', () => {
    const rules = R({ quietHours: ['00:00-24:00'], appPolicy: { mode: 'allowlist', apps: [] } });
    expect(run({ rules, observation: off }).action).toBe('none');
    expect(run({ rules, observation: { status: 'unknown', reason: 'unreachable' } }).action).toBe('none');
  });
});

describe('budgets', () => {
  it('per-app budget: remaining, exhausted at exactly the limit, bonus extends it', () => {
    const rules = R({ appBudgets: { '12': 60 } });
    const used = (m: number) => ({ screenMs: m * MIN, byApp: { '12': m * MIN } });
    expect(run({ rules, usage: used(59) })).toMatchObject({ action: 'none', remainingMs: { app: 1 * MIN } });
    expect(run({ rules, usage: used(60) })).toMatchObject({
      action: 'home',
      reason: 'app_budget',
      message: 'Netflix: daily limit of 60 min reached',
    });
    expect(run({ rules, usage: used(60), bonusMinutes: 15 })).toMatchObject({
      action: 'none',
      remainingMs: { app: 15 * MIN },
    });
  });

  it('global budget uses weekday vs weekend values', () => {
    const rules = R({ globalBudget: { weekday: 120, weekend: 180 } });
    const usage = { screenMs: 120 * MIN, byApp: { '837': 120 * MIN } };
    expect(run({ rules, usage })).toMatchObject({ action: 'home', reason: 'global_budget' });
    expect(run({ rules, usage, now: at('2026-10-03T10:00') })).toMatchObject({
      action: 'none',
      remainingMs: { global: 60 * MIN },
    });
  });

  it('accepts a single number for both, and custom weekend days', () => {
    const rules = R({ globalBudget: 90, weekendDays: ['fri', 'sat'] });
    expect(rules.globalBudget).toEqual({ weekday: 90, weekend: 90 });
    const r2 = R({ globalBudget: { weekday: 60, weekend: 120 }, weekendDays: ['fri', 'sat'] });
    const usage = { screenMs: 90 * MIN, byApp: {} };
    expect(run({ rules: r2, usage, now: at('2026-10-02T16:00') }).action).toBe('none'); // Friday = weekend here
    expect(run({ rules: r2, usage, now: at('2026-10-04T16:00') }).reason).toBe('global_budget'); // Sunday = weekday
  });

  it('exempt apps are never budgeted', () => {
    const rules = R({ globalBudget: 0 });
    expect(run({ rules, observation: app('dev') }).action).toBe('none');
  });
});

describe('schedules', () => {
  const quiet = R({ quietHours: ['20:30-07:00'] });

  it('quiet hours power the TV off even on the Home screen, across midnight', () => {
    expect(run({ rules: quiet, observation: home, now: at('2026-09-30T20:29') }).action).toBe('none');
    expect(run({ rules: quiet, observation: home, now: at('2026-09-30T20:30') })).toMatchObject({
      action: 'power_off',
      reason: 'quiet_hours',
      message: 'Quiet hours (20:30–07:00)',
    });
    expect(run({ rules: quiet, now: at('2026-09-30T23:59') }).reason).toBe('quiet_hours');
    expect(run({ rules: quiet, now: at('2026-10-01T06:59') }).reason).toBe('quiet_hours');
    expect(run({ rules: quiet, now: at('2026-10-01T07:00') }).action).toBe('none');
  });

  it('quiet hours can be limited to the days they start on', () => {
    const rules = R({ quietHours: [{ window: '22:00-08:00', days: ['weekends'] }] });
    expect(run({ rules, now: at('2026-10-03T23:00') }).reason).toBe('quiet_hours'); // Sat night
    expect(run({ rules, now: at('2026-10-05T07:00') }).reason).toBe('quiet_hours'); // Mon morning, from Sun night
    expect(run({ rules, now: at('2026-10-05T23:00') }).action).toBe('none'); // Mon night: not a start day
  });

  it('viewing windows: weekdays vs weekends, boundaries are [start, end)', () => {
    const rules = R({ viewingWindows: { weekdays: ['15:30-19:30'], weekends: ['08:00-20:00'] } });
    expect(run({ rules, now: at('2026-09-30T15:29') })).toMatchObject({
      action: 'power_off',
      reason: 'outside_window',
      message: 'Outside viewing hours (allowed: 15:30–19:30)',
    });
    expect(run({ rules, now: at('2026-09-30T15:30') }).action).toBe('none');
    expect(run({ rules, now: at('2026-09-30T19:29') }).action).toBe('none');
    expect(run({ rules, now: at('2026-09-30T19:30') }).reason).toBe('outside_window');
    expect(run({ rules, now: at('2026-10-03T08:00') }).action).toBe('none');
    expect(run({ rules, observation: home, now: at('2026-10-03T07:59') }).reason).toBe('outside_window');
  });

  it('a window past midnight belongs to the day it starts; [] means no viewing', () => {
    const rules = R({ viewingWindows: { fri: ['18:00-01:00'], sat: [] } });
    expect(run({ rules, now: at('2026-10-02T23:00') }).action).toBe('none');
    expect(run({ rules, now: at('2026-10-03T00:30') }).action).toBe('none'); // Fri's window, Sat 00:30
    expect(run({ rules, now: at('2026-10-03T01:00') })).toMatchObject({
      reason: 'outside_window',
      message: 'Outside viewing hours (allowed: none today)',
    });
    expect(run({ rules, now: at('2026-10-03T12:00') }).reason).toBe('outside_window');
  });

  it('days that are not listed are unrestricted; specific days beat groups', () => {
    const rules = R({ viewingWindows: { daily: ['16:00-18:00'], weekends: null, wed: ['10:00-11:00'] } });
    expect(run({ rules, now: at('2026-10-03T23:00') }).schedule.inViewingWindow).toBeNull(); // Sat unrestricted
    expect(run({ rules, now: at('2026-09-30T10:30') }).action).toBe('none'); // Wed override
    expect(run({ rules, now: at('2026-09-30T16:30') }).reason).toBe('outside_window'); // daily doesn't apply Wed
    expect(run({ rules, now: at('2026-10-01T16:30') }).action).toBe('none'); // Thu: daily
  });

  it('DST spring forward (2026-03-08): wall-clock boundaries still hold', () => {
    const rules = R({ quietHours: ['20:30-07:00'], viewingWindows: { sun: ['01:30-03:30', '02:30-04:00'] } });
    expect(run({ rules, now: at('2026-03-08T06:59') }).reason).toBe('quiet_hours');
    const early = R({ viewingWindows: { sun: ['01:30-03:30'] } });
    expect(run({ rules: early, now: at('2026-03-08T01:59') }).action).toBe('none'); // EST
    expect(run({ rules: early, now: at('2026-03-08T03:15') }).action).toBe('none'); // EDT, clock jumped
    expect(run({ rules: early, now: at('2026-03-08T03:30') }).reason).toBe('outside_window');
    // A window starting inside the skipped hour (02:30) is open from 03:00 on the clock.
    const gap = R({ viewingWindows: { sun: ['02:30-04:00'] } });
    expect(run({ rules: gap, now: at('2026-03-08T03:00') }).action).toBe('none');
  });

  it('DST fall back (2026-11-01): the repeated hour is inside a window both times', () => {
    const rules = R({ quietHours: ['00:30-01:30'] });
    const edt = DateTime.fromISO('2026-11-01T01:15:00-04:00').toMillis();
    const est = DateTime.fromISO('2026-11-01T01:15:00-05:00').toMillis();
    expect(est - edt).toBe(60 * MIN);
    expect(run({ rules, now: edt }).reason).toBe('quiet_hours');
    expect(run({ rules, now: est }).reason).toBe('quiet_hours');
    expect(run({ rules, now: DateTime.fromISO('2026-11-01T01:30:00-05:00').toMillis() }).action).toBe('none');
  });
});

describe('priority', () => {
  const everything = R({
    appPolicy: { mode: 'blocklist', apps: ['12'] },
    appBudgets: { '12': 10 },
    globalBudget: 10,
    viewingWindows: { daily: ['15:30-19:30'] },
    quietHours: ['20:30-07:00'],
  });
  const exhausted = { screenMs: 30 * MIN, byApp: { '12': 30 * MIN } };
  const night = at('2026-09-30T21:00');

  it('lock > quiet hours > outside window > blocked > app budget > global budget', () => {
    expect(run({ rules: everything, usage: exhausted, now: night, override: lock(null) }).reason).toBe('lock');
    expect(run({ rules: everything, usage: exhausted, now: night }).reason).toBe('quiet_hours');
    expect(run({ rules: everything, usage: exhausted, now: at('2026-09-30T20:00') }).reason).toBe('outside_window');
    expect(run({ rules: everything, usage: exhausted }).reason).toBe('app_blocked');
    const noBlock = R({ appBudgets: { '12': 10 }, globalBudget: 10 });
    expect(run({ rules: noBlock, usage: exhausted }).reason).toBe('app_budget');
    expect(run({ rules: noBlock, usage: exhausted, observation: app('837') }).reason).toBe('global_budget');
  });

  it('pause overrides everything until it expires', () => {
    const d = run({ rules: everything, usage: exhausted, now: night, override: pause(night + 30 * MIN) });
    expect(d).toMatchObject({ action: 'none', paused: true });
    expect(d.message).toMatch(/^Enforcement paused until 9:30 PM/);
    expect(run({ rules: everything, now: night, override: pause(night - 1) }).reason).toBe('quiet_hours'); // expired
  });

  it('lock powers the TV off on any screen, and only while the TV is on', () => {
    expect(run({ observation: home, override: lock(null) })).toMatchObject({ action: 'power_off', reason: 'lock' });
    expect(run({ observation: off, override: lock(null) }).action).toBe('none');
    expect(run({ override: lock(at(WED_4PM) - 1) }).action).toBe('none'); // expired
  });
});

describe('nextScheduleChange', () => {
  const rules = R({
    viewingWindows: { weekdays: ['15:30-19:30'], weekends: ['08:00-20:00'] },
    quietHours: ['20:30-07:00'],
  });

  it('finds the next boundary that actually changes something', () => {
    expect(nextScheduleChange(rules, at('2026-09-30T16:00'), TZ)).toEqual({
      at: at('2026-09-30T19:30'),
      label: 'Viewing window closes',
    });
    expect(nextScheduleChange(rules, at('2026-09-30T19:45'), TZ)).toEqual({
      at: at('2026-09-30T20:30'),
      label: 'Quiet hours start',
    });
    expect(nextScheduleChange(rules, at('2026-09-30T21:00'), TZ)).toEqual({
      at: at('2026-10-01T07:00'),
      label: 'Quiet hours end',
    });
    expect(nextScheduleChange(rules, at('2026-10-01T08:00'), TZ)).toEqual({
      at: at('2026-10-01T15:30'),
      label: 'Viewing window opens',
    });
  });

  it('handles DST days and "no rules"', () => {
    expect(nextScheduleChange(rules, at('2026-03-08T05:00'), TZ)?.at).toBe(at('2026-03-08T07:00'));
    expect(nextScheduleChange(R(), at(WED_4PM), TZ)).toBeNull();
  });
});

describe('window parsing', () => {
  it('parses and rejects', () => {
    expect(parseWindow('15:30-19:30')).toEqual({ start: 930, end: 1170 });
    expect(parseWindow('20:30 – 07:00')).toEqual({ start: 1230, end: 420 });
    expect(parseWindow('00:00-24:00')).toEqual({ start: 0, end: 0 });
    expect(parseWindow('18:00-24:00')).toEqual({ start: 1080, end: 1440 });
    expect(() => parseWindow('25:00-07:00')).toThrow(/Invalid time/);
    expect(() => parseWindow('7pm-9pm')).toThrow();
    expect(() => R({ quietHours: ['20:30-7'] })).toThrow(/Invalid time/);
  });
});
