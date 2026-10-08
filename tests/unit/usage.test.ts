import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { dayRangeFor, formatDuration, localDayRange } from '../../src/lib/time.js';
import { summarizeUsage, UsageService, type UsageSpan } from '../../src/usage/usage.js';
import { HOUR, memoryDb, MIN } from '../helpers.js';

const TZ = 'America/New_York';
const at = (iso: string): number => DateTime.fromISO(iso, { zone: TZ }).toMillis();
const span = (appId: string | null, start: string, end: string, kind: UsageSpan['kind'] = 'app'): UsageSpan => ({
  kind,
  appId,
  appName: appId,
  startedAt: at(start),
  endAt: at(end),
});

describe('localDayRange', () => {
  it('is 24h on a normal day', () => {
    const r = localDayRange(at('2026-09-30T15:00'), TZ);
    expect(r.day).toBe('2026-09-30');
    expect(r.end - r.start).toBe(24 * HOUR);
    expect(r.start).toBe(at('2026-09-30T00:00'));
  });

  it('is 23h on spring-forward day (2026-03-08)', () => {
    const r = dayRangeFor('2026-03-08', TZ);
    expect(r.end - r.start).toBe(23 * HOUR);
  });

  it('is 25h on fall-back day (2026-11-01)', () => {
    const r = dayRangeFor('2026-11-01', TZ);
    expect(r.end - r.start).toBe(25 * HOUR);
  });

  it('assigns just-before and just-after midnight to different days', () => {
    expect(localDayRange(at('2026-09-30T23:59:59'), TZ).day).toBe('2026-09-30');
    expect(localDayRange(at('2026-10-01T00:00:00'), TZ).day).toBe('2026-10-01');
  });

  it('uses the configured zone, not the host zone', () => {
    // 03:30 UTC on Oct 1 is still Sep 30 in New York.
    expect(localDayRange(Date.UTC(2026, 9, 1, 3, 30), TZ).day).toBe('2026-09-30');
  });
});

describe('summarizeUsage', () => {
  it('splits a session across midnight', () => {
    const s = [span('12', '2026-09-30T23:30', '2026-10-01T00:30')];
    expect(summarizeUsage(s, dayRangeFor('2026-09-30', TZ)).screenMs).toBe(30 * MIN);
    expect(summarizeUsage(s, dayRangeFor('2026-10-01', TZ)).screenMs).toBe(30 * MIN);
  });

  it('counts real elapsed time across the spring-forward gap', () => {
    // 01:30 EST → 03:30 EDT is one real hour.
    const s = [span('12', '2026-03-08T01:30', '2026-03-08T03:30')];
    expect(summarizeUsage(s, dayRangeFor('2026-03-08', TZ)).screenMs).toBe(1 * HOUR);
  });

  it('counts the repeated hour on fall-back day', () => {
    const r = dayRangeFor('2026-11-01', TZ);
    const s: UsageSpan[] = [{ kind: 'app', appId: '12', appName: 'Netflix', startedAt: r.start, endAt: r.end }];
    expect(summarizeUsage(s, r).screenMs).toBe(25 * HOUR);
  });

  it('separates home, screensaver and excluded apps from screen time', () => {
    const s = [
      span('12', '2026-09-30T16:00', '2026-09-30T16:45'),
      span('837', '2026-09-30T17:00', '2026-09-30T17:20'),
      span('12', '2026-09-30T18:00', '2026-09-30T18:10'),
      span(null, '2026-09-30T16:45', '2026-09-30T17:00', 'home'),
      span('55545', '2026-09-30T19:00', '2026-09-30T19:30', 'screensaver'),
      span('dev', '2026-09-30T20:00', '2026-09-30T20:05'),
    ];
    const u = summarizeUsage(s, dayRangeFor('2026-09-30', TZ), { excludeAppIds: ['dev'] });
    expect(u.screenMs).toBe(75 * MIN);
    expect(u.homeMs).toBe(15 * MIN);
    expect(u.screensaverMs).toBe(30 * MIN);
    expect(u.byApp).toEqual([
      { appId: '12', appName: '12', ms: 55 * MIN },
      { appId: '837', appName: '837', ms: 20 * MIN },
    ]);
  });

  it('ignores spans entirely outside the range', () => {
    expect(
      summarizeUsage([span('12', '2026-09-29T10:00', '2026-09-29T11:00')], dayRangeFor('2026-09-30', TZ)).screenMs,
    ).toBe(0);
  });
});

describe('UsageService (SQLite)', () => {
  it('counts closed sessions and the open one up to last_seen_at', () => {
    const { repos } = memoryDb();
    const a = repos.sessions.open({
      deviceSerial: 'TV',
      kind: 'app',
      appId: '12',
      appName: 'Netflix',
      startedAt: at('2026-09-30T23:00'),
    });
    repos.sessions.touch(a, at('2026-09-30T23:40'));
    repos.sessions.close(a, 'switch');
    const b = repos.sessions.open({
      deviceSerial: 'TV',
      kind: 'app',
      appId: '837',
      appName: 'YouTube',
      startedAt: at('2026-09-30T23:45'),
    });
    repos.sessions.touch(b, at('2026-10-01T00:20')); // still open, straddles midnight

    const svc = new UsageService(repos.sessions, TZ, ['dev']);
    const sep30 = svc.forDay(at('2026-09-30T12:00'));
    expect(sep30.range.day).toBe('2026-09-30');
    expect(sep30.screenMs).toBe(40 * MIN + 15 * MIN);
    const oct1 = svc.forDay(at('2026-10-01T08:00'));
    expect(oct1.byApp).toEqual([{ appId: '837', appName: 'YouTube', ms: 20 * MIN }]);
  });
});

describe('formatDuration', () => {
  it('formats compactly', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(12 * MIN + 30_000)).toBe('12m 30s');
    expect(formatDuration(HOUR + 5 * MIN)).toBe('1h 05m');
  });
});
