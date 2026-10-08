import { DateTime } from 'luxon';
import { afterEach, describe, expect, it } from 'vitest';
import { createGuardian, type Guardian } from '../../src/app.js';
import type { ConfigInput } from '../../src/config/schema.js';
import type { EnforcementEvent } from '../../src/enforce/enforcer.js';
import { silentLogger } from '../../src/lib/logger.js';
import type { MockRoku } from '../../mock/mock-roku.js';
import { fakeClock, memoryDb, mockRoku, MIN, SEC, testConfig, type FakeClock } from '../helpers.js';

/** "Time's up" channel installed on the mock TV: messages, countdowns, warnings, parent messages. */

const TZ = 'America/New_York';
const local = (iso: string): number => DateTime.fromISO(iso, { zone: TZ }).toMillis();
const decode = (v: string | undefined): string => (v ? Buffer.from(v, 'base64url').toString('utf8') : '');

const mocks: MockRoku[] = [];
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((m) => m.close()));
});

interface Harness {
  tv: MockRoku;
  g: Guardian;
  clock: FakeClock;
  events: EnforcementEvent[];
  tick(advanceMs?: number): Promise<void>;
  keys(): string[];
  launches(): string[];
  /** What the channel shows now, decoded (null if it isn't on screen). */
  screen(): { kind: string; title: string; body: string; countdown: number; dismissable: boolean } | null;
}

async function setup(
  config: ConfigInput,
  opts: { start?: string; initial?: NonNullable<Parameters<typeof mockRoku>[0]>['initial'] } = {},
): Promise<Harness> {
  const tv = await mockRoku({ initial: { devChannelInstalled: true, ...opts.initial } });
  mocks.push(tv);
  const clock = fakeClock(local(opts.start ?? '2026-09-30T16:00')); // Wednesday 4 PM
  const g = createGuardian(
    testConfig({
      device: { host: '127.0.0.1', port: tv.ecpPort },
      monitor: { pollIntervalSec: 5, requestTimeoutMs: 500, restrictionProbeIntervalSec: 0 },
      enforcement: { mode: 'enforce' },
      ...config,
    }),
    silentLogger(),
    {
      clock,
      db: memoryDb().db,
      reachability: { presence: async () => ({ alive: true, mac: null }) },
      ssdp: async () => [],
      scan: async () => [],
    },
  );
  const events: EnforcementEvent[] = [];
  g.bus.on('enforcement', (e) => events.push(e));
  return {
    tv,
    g,
    clock,
    events,
    tick: async (advanceMs = 5 * SEC) => {
      clock.advance(advanceMs);
      await g.poller.tick();
      await g.enforcer.idle();
    },
    keys: () => tv.history.filter((h) => h.path.startsWith('/keypress/')).map((h) => h.path.slice('/keypress/'.length)),
    launches: () => tv.history.filter((h) => h.path.startsWith('/launch/')).map((h) => h.path.slice('/launch/'.length)),
    screen: () => {
      const m = tv.state.activeAppId === 'dev' ? tv.state.devMessage : null;
      if (!m?.t) return null;
      return {
        kind: m.kind ?? '',
        title: decode(m.t),
        body: decode(m.b),
        countdown: Number(m.cd ?? 0),
        dismissable: m.ok !== '0',
      };
    },
  };
}

describe('TV messages (Parental Control channel installed)', () => {
  it('a blocked app gets an explanation instead of a bare Home press', async () => {
    const h = await setup(
      { rules: { appPolicy: { mode: 'blocklist', apps: ['837'] } } },
      { initial: { activeAppId: '837' } },
    );
    await h.tick(0);
    expect(h.keys()).toEqual([]);
    expect(h.launches()).toEqual(['dev']);
    expect(h.screen()).toEqual({
      kind: 'blocked',
      title: 'YouTube isn’t allowed',
      body: 'Pick something else to watch, or ask a parent.',
      countdown: 0,
      dismissable: true,
    });
    expect(h.events[0]).toMatchObject({
      action: 'home',
      result: 'sent',
      shown: { title: 'YouTube isn’t allowed', countdownSec: 0 },
      message: 'Showed “YouTube isn’t allowed” on the TV — YouTube is blocked',
    });

    // The channel itself is exempt, and its time isn't counted.
    await h.tick();
    await h.tick();
    expect(h.launches()).toEqual(['dev']);
    expect(h.g.usage.forDay(h.clock.now()).screenMs).toBe(0);

    // OK closes the message (→ Home); nothing else happens.
    h.tv.remote({ key: 'Select' });
    await h.tick();
    expect(h.tv.state.activeAppId).toBeNull();
    expect(h.keys()).toEqual([]);
  });

  it('daily limit: "Screen time’s up" with the tip on earning more time, in the parent’s words once edited', async () => {
    const h = await setup({ rules: { globalBudget: 1 } }, { initial: { activeAppId: '12' } });
    await h.tick(0);
    for (let i = 0; i < 12; i++) await h.tick(); // 1 minute of Netflix
    await h.tick();
    expect(h.screen()).toEqual({
      kind: 'budget',
      title: 'Screen time’s up for today',
      body: 'You can watch again tomorrow.\nTo get more time on the TV, read a book, do a chore or practice Python programming.',
      countdown: 0,
      dismissable: true,
    });

    // Changed in the dashboard: used the next time it's shown.
    h.g.runtime.update('tvMessages', {
      ...h.g.runtime.tvMessages,
      texts: {
        global_budget: {
          title: 'That’s it for today',
          body: 'You can watch again {next}.\nAsk a parent about bonus time.',
        },
      },
    });
    h.tv.remote({ launch: '12' });
    h.clock.advance(15 * SEC); // past the Home cooldown
    await h.tick();
    expect(h.screen()).toMatchObject({
      title: 'That’s it for today',
      body: 'You can watch again tomorrow.\nAsk a parent about bonus time.',
    });
  });

  it('quiet hours: a 30-second countdown on the TV, then PowerOff', async () => {
    const h = await setup({ rules: { quietHours: ['20:30-07:00'] } }, { start: '2026-09-30T20:29:55' });
    await h.tick(0);
    await h.tick(); // 20:30:00
    expect(h.screen()).toMatchObject({
      kind: 'schedule',
      title: 'It’s quiet time',
      body: 'The TV stays off until tomorrow at 7:00 AM.',
      countdown: 30,
      dismissable: false,
    });
    expect(h.events[0]).toMatchObject({ action: 'power_off', reason: 'quiet_hours', result: 'sent' });
    expect(h.events[0]?.pendingUntil).toBe(local('2026-09-30T20:30:30'));
    expect(h.g.enforcer.getCountdown()?.title).toBe('It’s quiet time');

    for (let i = 0; i < 5; i++) await h.tick(); // 25 s
    expect(h.keys()).toEqual([]);
    await h.tick(); // 30 s
    expect(h.keys()).toEqual(['PowerOff']);
    expect(h.tv.state.power).toBe('DisplayOff');
    expect(h.events.at(-1)).toMatchObject({
      afterCountdown: true,
      message: 'Sent PowerOff — Quiet hours (20:30–07:00)',
    });
    expect(h.g.enforcer.getCountdown()).toBeNull();

    // Switched back on soon after: the short countdown (10 s) once the PowerOff cooldown has passed.
    h.tv.remote({ key: 'PowerOn' });
    await h.tick(15 * SEC);
    expect(h.screen()?.countdown).toBe(10);
    await h.tick(10 * SEC);
    expect(h.keys()).toEqual(['PowerOff', 'PowerOff']);
  });

  it('a countdown stops when a parent pauses the rules, and the message is taken off the screen', async () => {
    const h = await setup({ rules: { quietHours: ['20:30-07:00'] } }, { start: '2026-09-30T20:31' });
    await h.tick(0);
    expect(h.screen()?.countdown).toBe(30);
    h.g.repos.overrides.set({ kind: 'pause', until: null, setAt: h.clock.now(), note: null });
    await h.tick();
    expect(h.keys()).toEqual(['Home']);
    expect(h.tv.state.power).toBe('PowerOn');
    expect(h.g.enforcer.getCountdown()).toBeNull();
    expect(h.g.repos.events.recent({ type: 'enforcement' })[0]?.message).toBe('Countdown stopped: rules paused');
    await h.tick(60 * SEC);
    expect(h.keys()).toEqual(['Home']);
  });

  it('outside viewing hours, the message says when TV time starts', async () => {
    const h = await setup(
      { rules: { viewingWindows: { weekdays: ['15:30-19:30'], weekends: ['08:00-20:00'] } } },
      { start: '2026-09-30T14:00' },
    );
    await h.tick(0);
    expect(h.screen()).toMatchObject({ title: 'It’s not TV time yet', body: 'TV time starts at 3:30 PM.' });

    const late = await setup(
      { rules: { viewingWindows: { weekdays: ['15:30-19:30'], weekends: ['08:00-20:00'] } } },
      { start: '2026-10-02T19:45' }, // Friday evening → Saturday morning
    );
    await late.tick(0);
    expect(late.screen()).toMatchObject({
      title: 'TV time is over for today',
      body: 'TV time starts again tomorrow at 8:00 AM.',
    });
  });

  it('escalation shows why before turning the TV off', async () => {
    const h = await setup({ rules: { appPolicy: { mode: 'blocklist', apps: ['837'] } } });
    await h.tick(0);
    for (const advance of [5 * SEC, 11 * SEC]) {
      h.tv.remote({ launch: '837' });
      await h.tick(advance);
    }
    expect(h.launches()).toEqual(['dev', 'dev']);
    h.tv.remote({ launch: '837' });
    await h.tick(11 * SEC); // 3rd within 5 min
    expect(h.screen()).toMatchObject({ title: 'The TV is turning off', countdown: 10 });
    expect(h.events.at(-1)).toMatchObject({ action: 'power_off', escalatedFrom: 'app_blocked' });
    h.tv.remote({ key: 'Home' }); // escaping the countdown doesn't stop it
    await h.tick(10 * SEC);
    expect(h.keys()).toEqual(['PowerOff']);
  });

  it('budget warning: N minutes before, then back to the show; bonus time re-arms it', async () => {
    const h = await setup(
      { rules: { globalBudget: 6 }, tvMessages: { warnBeforeMin: 5, warningSec: 8 } },
      { initial: { activeAppId: '12' } },
    );
    await h.tick(0);
    for (let i = 0; i < 12; i++) await h.tick(); // 60 s watched → 5 min left
    expect(h.screen()).toMatchObject({ kind: 'warning', title: '5 minutes left', countdown: 8, dismissable: true });
    expect(h.screen()?.body).toBe('Today’s screen time is nearly used up. Time to finish what you’re watching.');
    await h.tick(); // +5 s: still showing
    expect(h.tv.state.activeAppId).toBe('dev');
    await h.tick(); // +10 s ≥ 8 s → back to Netflix
    expect(h.launches()).toEqual(['dev', '12']);
    expect(h.tv.state.activeAppId).toBe('12');

    for (let i = 0; i < 6; i++) await h.tick(); // no second warning
    expect(h.launches()).toEqual(['dev', '12']);

    h.g.repos.overrides.addBonus('2026-09-30', 2, h.clock.now()); // over 6 min left again → re-armed
    await h.tick();
    expect(h.g.enforcer.getLastDecision()!.remainingMs.global!).toBeGreaterThan(6 * MIN);
    for (let i = 0; i < 30 && h.launches().length < 3; i++) await h.tick();
    expect(h.launches()).toEqual(['dev', '12', 'dev']);
    expect(h.g.enforcer.getLastDecision()!.remainingMs.global!).toBeLessThanOrEqual(5 * MIN);
  });

  it('OK on a warning goes straight back to the show', async () => {
    const h = await setup(
      { rules: { appBudgets: { '12': 6 } }, tvMessages: { warnBeforeMin: 5, warningSec: 30 } },
      { initial: { activeAppId: '12' } },
    );
    await h.tick(0);
    for (let i = 0; i < 12; i++) await h.tick();
    expect(h.screen()?.title).toBe('5 minutes of Netflix left');
    h.tv.remote({ key: 'Select' }); // → Home
    await h.tick();
    expect(h.tv.state.activeAppId).toBe('12');
  });

  it('schedule warning before the viewing window closes', async () => {
    const h = await setup(
      { rules: { viewingWindows: { daily: ['15:30-19:30'] } }, tvMessages: { warnBeforeMin: 5 } },
      { start: '2026-09-30T19:24:50', initial: { activeAppId: '12' } },
    );
    await h.tick(0);
    expect(h.screen()).toBeNull();
    await h.tick(10 * SEC); // 19:25:00
    expect(h.screen()).toMatchObject({
      title: '5 minutes left',
      body: 'TV time ends at 7:30 PM. Time to finish what you’re watching.',
    });
  });

  it('a new message while the channel is open replaces it in place (ECP /input)', async () => {
    const h = await setup(
      { rules: { appPolicy: { mode: 'blocklist', apps: ['837'] }, quietHours: ['20:30-07:00'] } },
      {
        start: '2026-09-30T20:29:50',
        initial: { activeAppId: '837' },
      },
    );
    await h.tick(0);
    expect(h.screen()?.kind).toBe('blocked');
    await h.tick(10 * SEC); // quiet hours begin while the message is up
    expect(h.screen()).toMatchObject({ kind: 'schedule', countdown: 30 });
    expect(h.tv.history.filter((c) => c.path === '/input')).toHaveLength(1);
    expect(h.launches()).toEqual(['dev']);
  });

  it('falls back to Home when the channel has gone missing', async () => {
    const h = await setup({ rules: { appPolicy: { mode: 'blocklist', apps: ['837'] } } });
    await h.tick(0); // apps list synced: channel installed
    await h.tv.set({ devChannelInstalled: false }); // removed on the TV (developer mode turned off)
    h.tv.remote({ launch: '837' });
    await h.tick();
    expect(h.keys()).toEqual(['Home']);
    expect(h.g.enforcer.tv.ready()).toBe(false);
  });

  it('dry-run says what it would show, and touches nothing', async () => {
    const h = await setup(
      { rules: { appPolicy: { mode: 'blocklist', apps: ['837'] } }, enforcement: { mode: 'dry-run' } },
      { initial: { activeAppId: '837' } },
    );
    await h.tick(0);
    expect(h.launches()).toEqual([]);
    expect(h.events[0]?.message).toBe(
      'Practice mode: would show “YouTube isn’t allowed” on the TV — YouTube is blocked',
    );
  });

  it('dashboard lock: short countdown, then PowerOff — even in dry-run', async () => {
    const h = await setup({ enforcement: { mode: 'dry-run' } }, { initial: { activeAppId: '12' } });
    await h.tick(0);
    h.g.repos.overrides.set({ kind: 'lock', until: null, setAt: h.clock.now(), note: 'dashboard' });
    expect(await h.g.enforcer.lockNow()).toBe('the TV turns off in 10 seconds');
    expect(h.screen()).toMatchObject({ kind: 'lock', title: 'The TV is locked', body: 'A parent has locked the TV.' });
    await h.tick(10 * SEC);
    expect(h.keys()).toEqual(['PowerOff']);

    // Unlocking during a countdown cancels it.
    h.g.repos.overrides.clear();
    h.tv.remote({ key: 'PowerOn', launch: '12' });
    await h.tick(20 * SEC);
    h.g.repos.overrides.set({ kind: 'lock', until: null, setAt: h.clock.now(), note: 'dashboard' });
    await h.g.enforcer.lockNow();
    h.g.repos.overrides.clear();
    await h.tick(5 * SEC);
    await h.tick(10 * SEC);
    expect(h.keys()).toEqual(['PowerOff', 'Home']);
    expect(h.tv.state.power).toBe('PowerOn');
  });

  it('parent messages: shown on the TV, optionally back to the show', async () => {
    const h = await setup({}, { initial: { activeAppId: '12' } });
    await h.tick(0);
    await expect(h.g.enforcer.sendMessage('Dinner’s ready!', { returnToShow: true })).resolves.toBe(
      'Message shown on the TV',
    );
    expect(h.screen()).toMatchObject({
      kind: 'message',
      title: 'Dinner’s ready!',
      body: 'From a parent',
      countdown: 15,
    });
    await h.tick(15 * SEC);
    expect(h.tv.state.activeAppId).toBe('12');

    const long = 'Please come downstairs and help set the table, then you can finish the episode after dinner.';
    await h.g.enforcer.sendMessage(long, { returnToShow: false });
    expect(h.screen()).toMatchObject({ title: 'A message from a parent', body: long, countdown: 0 });

    await h.tv.set({ power: 'DisplayOff' });
    await h.tick();
    await expect(h.g.enforcer.sendMessage('Hello', { returnToShow: false })).rejects.toMatchObject({ kind: 'tv_off' });
  });
});
