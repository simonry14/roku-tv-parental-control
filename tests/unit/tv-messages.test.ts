import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { RulesConfigSchema } from '../../src/config/rules-schema.js';
import { TvTextsSchema } from '../../src/config/schema.js';
import {
  cleanMessageText,
  enforcementMessage,
  minutesText,
  parentMessage,
  toChannelParams,
  warningMessage,
  whenText,
} from '../../src/enforce/tv-messages.js';
import { allowedUntil, nextAllowedAt, scheduleAllows } from '../../src/rules/schedule.js';
import type { Decision, ReasonCode } from '../../src/rules/types.js';

const TZ = 'America/New_York';
const at = (iso: string): number => DateTime.fromISO(iso, { zone: TZ }).toMillis();
const rules = RulesConfigSchema.parse({
  viewingWindows: { weekdays: ['15:30-19:30'], weekends: ['08:00-20:00'] },
  quietHours: ['20:30-07:00'],
});

const decision = (reason: ReasonCode, appName: string | null = 'YouTube'): Decision => ({
  action: reason.startsWith('app') || reason === 'global_budget' ? 'home' : 'power_off',
  reason,
  message: '',
  paused: false,
  appId: appName ? '837' : null,
  appName,
  remainingMs: { global: null, app: null },
  schedule: { inQuietHours: false, inViewingWindow: null },
});

const msg = (reason: ReasonCode, now: string, extra: Partial<Parameters<typeof enforcementMessage>[0]> = {}) =>
  enforcementMessage({
    decision: decision(reason),
    rules,
    override: null,
    escalated: false,
    countdownSec: 30,
    now: at(now),
    zone: TZ,
    ...extra,
  });

describe('schedule helpers', () => {
  it('nextAllowedAt skips quiet hours and closed windows', () => {
    expect(scheduleAllows(rules, at('2026-09-30T16:00'), TZ)).toBe(true);
    expect(nextAllowedAt(rules, at('2026-09-30T16:00'), TZ)).toBe(at('2026-09-30T16:00'));
    // Wednesday night → Thursday's window (quiet hours end at 7, but the window opens at 15:30).
    expect(nextAllowedAt(rules, at('2026-09-30T21:00'), TZ)).toBe(at('2026-10-01T15:30'));
    // Friday night → Saturday 08:00.
    expect(nextAllowedAt(rules, at('2026-10-02T21:00'), TZ)).toBe(at('2026-10-03T08:00'));
  });

  it('allowedUntil is when the current allowed stretch ends', () => {
    expect(allowedUntil(rules, at('2026-09-30T16:00'), TZ)).toBe(at('2026-09-30T19:30'));
    expect(allowedUntil(rules, at('2026-10-03T19:00'), TZ)).toBe(at('2026-10-03T20:00'));
    expect(allowedUntil(rules, at('2026-09-30T21:00'), TZ)).toBeNull();
  });

  it('works across the November DST change (wall-clock times)', () => {
    // Sat 2026-10-31 → Sun 2026-11-01 (clocks fall back at 2:00). Sunday window opens 08:00 local.
    expect(nextAllowedAt(rules, at('2026-10-31T21:00'), TZ)).toBe(at('2026-11-01T08:00'));
  });
});

describe('enforcement messages', () => {
  it('app rules: short, kind, dismissable', () => {
    expect(msg('app_blocked', '2026-09-30T16:00')).toMatchObject({
      kind: 'blocked',
      title: 'YouTube isn’t allowed',
      dismissable: true,
      countdownSec: 0,
    });
    expect(msg('app_budget', '2026-09-30T16:00')).toMatchObject({
      kind: 'budget',
      title: 'No more YouTube today',
      body: 'You’ve used up today’s time for YouTube. You can still watch something else.',
    });
  });

  it('global budget: says when viewing starts again, then how to earn more time', () => {
    const TIP = 'To get more time on the TV, read a book, do a chore or practice Python programming.';
    expect(msg('global_budget', '2026-09-30T18:00').body).toBe(`You can watch again tomorrow from 3:30 PM.\n${TIP}`);
    expect(msg('global_budget', '2026-10-02T18:00').body.split('\n')[0]).toBe(
      'You can watch again tomorrow from 8:00 AM.',
    );
    const unrestricted = RulesConfigSchema.parse({});
    expect(
      enforcementMessage({
        decision: decision('global_budget'),
        rules: unrestricted,
        override: null,
        escalated: false,
        countdownSec: 0,
        now: at('2026-09-30T18:00'),
        zone: TZ,
      }).body.split('\n')[0],
    ).toBe('You can watch again tomorrow.');
    // No TV at the weekend: Friday evening → Monday.
    const weekdaysOnly = RulesConfigSchema.parse({ viewingWindows: { weekdays: ['15:30-19:30'], weekends: [] } });
    expect(msg('global_budget', '2026-10-02T18:00', { rules: weekdaysOnly }).body.split('\n')[0]).toBe(
      'You can watch again Monday from 3:30 PM.',
    );
  });

  it('uses the parent’s rewritten words, filling in the blanks', () => {
    const texts = TvTextsSchema.parse({
      global_budget: { body: 'That’s {limit} for today. Back {next}!' },
      app_blocked: { title: 'Not {app}, sorry', body: '' },
      quiet_hours: { body: 'Bedtime. The TV stays off {until}.' },
      over_for_today: { body: 'TV time starts again {next}.\nSleep well!' },
      countdown_off: { line: 'Off in {seconds}…', end: '' },
    });
    const withBudget = RulesConfigSchema.parse({
      viewingWindows: { weekdays: ['15:30-19:30'], weekends: ['08:00-20:00'] },
      globalBudget: 120,
    });
    expect(msg('global_budget', '2026-09-30T18:00', { texts, rules: withBudget }).body).toBe(
      'That’s 2 hours for today. Back tomorrow from 3:30 PM!',
    );
    // No daily limit set: the line that mentions {limit} is left out.
    expect(msg('global_budget', '2026-09-30T18:00', { texts }).body).toBe('');
    expect(msg('app_blocked', '2026-09-30T16:00', { texts })).toMatchObject({ title: 'Not YouTube, sorry', body: '' });
    const quiet = msg('quiet_hours', '2026-09-30T21:00', { texts });
    expect(quiet).toMatchObject({
      body: 'Bedtime. The TV stays off until tomorrow at 3:30 PM.',
      countdownText: 'Off in ^0 ^1…',
      countdownEnd: '',
    });
    // Nothing allowed for a week: the line with the unknown {next} is left out, the rest stays.
    const never = RulesConfigSchema.parse({ viewingWindows: { daily: [] } });
    expect(msg('outside_window', '2026-09-30T21:00', { texts, rules: never }).body).toBe('Sleep well!');
    // Untouched messages keep their defaults.
    expect(msg('app_budget', '2026-09-30T16:00', { texts }).title).toBe('No more YouTube today');
  });

  it('a lock without an end time just says it’s locked', () => {
    expect(
      msg('lock', '2026-09-30T16:00', { override: { kind: 'lock', until: null, setAt: 0, note: null } }).body,
    ).toBe('A parent has locked the TV.');
  });

  it('schedule messages count down and cannot be dismissed', () => {
    const quiet = msg('quiet_hours', '2026-09-30T21:00');
    expect(quiet).toMatchObject({
      kind: 'schedule',
      title: 'It’s quiet time',
      body: 'The TV stays off until tomorrow at 3:30 PM.',
      countdownSec: 30,
      countdownText: 'The TV turns off in ^0 ^1',
      dismissable: false,
    });
    expect(msg('outside_window', '2026-09-30T10:00')).toMatchObject({
      title: 'It’s not TV time yet',
      body: 'TV time starts at 3:30 PM.',
    });
    expect(msg('outside_window', '2026-10-02T19:45').body).toBe('TV time starts again tomorrow at 8:00 AM.');
    // Monday morning, a window on Monday afternoon.
    expect(msg('quiet_hours', '2026-10-04T23:00').body).toBe('The TV stays off until tomorrow at 3:30 PM.');
  });

  it('lock and escalation', () => {
    expect(
      msg('lock', '2026-09-30T16:00', {
        override: { kind: 'lock', until: at('2026-09-30T18:00'), setAt: 0, note: null },
        countdownSec: 10,
      }),
    ).toMatchObject({ kind: 'lock', title: 'The TV is locked', body: 'A parent has locked the TV until 6:00 PM.' });
    expect(msg('app_blocked', '2026-09-30T16:00', { escalated: true, countdownSec: 10 })).toMatchObject({
      title: 'The TV is turning off',
      body: 'You kept opening YouTube, so the TV is switching off.',
      countdownSec: 10,
      dismissable: false,
    });
  });
});

describe('warnings, parent messages, channel parameters', () => {
  it('warnings name what runs out and where they go back to', () => {
    const now = at('2026-09-30T19:25');
    expect(
      warningMessage({
        minutesLeft: 5,
        scope: 'schedule',
        endsAt: at('2026-09-30T19:30'),
        appName: 'Netflix',
        returnSec: 8,
        now,
        zone: TZ,
      }),
    ).toMatchObject({
      kind: 'warning',
      title: '5 minutes left',
      body: 'TV time ends at 7:30 PM. Time to finish what you’re watching.',
      countdownSec: 8,
      countdownText: 'Back to Netflix in ^0 ^1',
      dismissable: true,
    });
    expect(
      warningMessage({ minutesLeft: 1, scope: 'app', endsAt: now, appName: 'Netflix', returnSec: 8, now, zone: TZ })
        .title,
    ).toBe('1 minute of Netflix left');
  });

  it('parent messages: short ones are the headline, long ones the body', () => {
    expect(parentMessage('  Dinner’s\nready!  ', { returnSec: 0, appName: null })).toMatchObject({
      title: 'Dinner’s ready!',
      body: 'From a parent',
      countdownSec: 0,
    });
    const long = 'x'.repeat(80);
    expect(parentMessage(long, { returnSec: 15, appName: 'PBS KIDS' })).toMatchObject({
      title: 'A message from a parent',
      body: long,
      countdownSec: 15,
      countdownText: 'Back to PBS KIDS in ^0 ^1',
    });
    expect(cleanMessageText('a'.repeat(500))).toHaveLength(140);
  });

  it('channel parameters are base64url (no URL escaping needed) and round-trip', () => {
    const m = msg('quiet_hours', '2026-09-30T21:00');
    const p = toChannelParams(m);
    expect(p).toMatchObject({ v: '1', kind: 'schedule', cd: '30', ok: '0' });
    for (const v of Object.values(p)) expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(p.t!, 'base64url').toString('utf8')).toBe('It’s quiet time');
    expect(Buffer.from(p.ct!, 'base64url').toString('utf8')).toBe('The TV turns off in ^0 ^1');
    expect(toChannelParams(msg('app_blocked', '2026-09-30T16:00'))).not.toHaveProperty('cd');
  });

  it('formats times and durations for people', () => {
    const now = at('2026-09-30T21:00');
    expect(whenText(at('2026-09-30T22:15'), now, TZ)).toBe('10:15 PM');
    expect(whenText(at('2026-10-01T07:00'), now, TZ)).toBe('tomorrow at 7:00 AM');
    expect(whenText(at('2026-10-03T08:00'), now, TZ)).toBe('Saturday at 8:00 AM');
    expect(minutesText(1)).toBe('1 minute');
    expect(minutesText(60)).toBe('1 hour');
    expect(minutesText(150)).toBe('2 hours and 30 minutes');
  });
});
