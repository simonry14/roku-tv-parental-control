import { DateTime } from 'luxon';
import { afterEach, describe, expect, it } from 'vitest';
import { createGuardian, type Guardian } from '../../src/app.js';
import type { ConfigInput } from '../../src/config/schema.js';
import type { EnforcementEvent } from '../../src/enforce/enforcer.js';
import { silentLogger } from '../../src/lib/logger.js';
import type { MockRoku } from '../../mock/mock-roku.js';
import { fakeClock, memoryDb, mockRoku, SEC, testConfig, type FakeClock } from '../helpers.js';

const TZ = 'America/New_York';
const local = (iso: string): number => DateTime.fromISO(iso, { zone: TZ }).toMillis();

const mocks: MockRoku[] = [];
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((m) => m.close()));
});

interface Harness {
  tv: MockRoku;
  g: Guardian;
  clock: FakeClock;
  events: EnforcementEvent[];
  /** Advance the fake clock, poll once, and wait for the enforcer to finish acting. */
  tick(advanceMs?: number): Promise<void>;
  keys(): string[];
}

async function setup(
  config: ConfigInput,
  opts: { start?: string; initial?: Parameters<typeof mockRoku>[0] } = {},
): Promise<Harness> {
  // Plain Home/PowerOff: the Parental Control channel is not installed (tv-messages.test.ts covers it).
  const tv = await mockRoku({
    ...opts.initial,
    initial: { devChannelInstalled: false, ...opts.initial?.initial },
  });
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
  };
}

describe('Enforcer ↔ mock Roku', () => {
  it('sends Home for a blocked app and logs the reason', async () => {
    const h = await setup(
      { rules: { appPolicy: { mode: 'blocklist', apps: ['837'] } } },
      { initial: { initial: { activeAppId: '837' } } },
    );
    await h.tick(0);
    expect(h.keys()).toEqual(['Home']);
    expect(h.tv.state.activeAppId).toBeNull();
    expect(h.events[0]).toMatchObject({
      action: 'home',
      reason: 'app_blocked',
      result: 'sent',
      message: 'Sent Home — YouTube is blocked',
    });
    expect(h.g.repos.events.recent({ type: 'enforcement' })[0]?.message).toBe('Sent Home — YouTube is blocked');

    // Allowed app: nothing happens.
    h.tv.remote({ launch: '12' });
    await h.tick();
    await h.tick();
    expect(h.keys()).toEqual(['Home']);
  });

  it('cooldown prevents keypress spam; escalation powers off on the 3rd violation within 5 min', async () => {
    const h = await setup({ rules: { appPolicy: { mode: 'blocklist', apps: ['837'] } } });
    await h.tick(0);

    h.tv.remote({ launch: '837' });
    await h.tick(); // violation 1 → Home
    // A mock keypress takes effect instantly; simulate a kid relaunching within the 10 s cooldown.
    h.tv.remote({ launch: '837' });
    await h.tick(); // +5 s: cooldown → skipped
    expect(h.keys()).toEqual(['Home']);
    await h.tick(); // +10 s since the last Home → violation 2 → Home
    expect(h.keys()).toEqual(['Home', 'Home']);

    h.tv.remote({ launch: '837' });
    await h.tick(11 * SEC); // violation 3 → PowerOff
    expect(h.keys()).toEqual(['Home', 'Home', 'PowerOff']);
    expect(h.tv.state.power).toBe('DisplayOff');
    expect(h.events.at(-1)).toMatchObject({ action: 'power_off', reason: 'app_blocked', escalatedFrom: 'app_blocked' });
    expect(h.events.at(-1)?.message).toMatch(/repeated 3× within 5 min/);
  });

  it('violations older than the escalation window do not count', async () => {
    const h = await setup({ rules: { appPolicy: { mode: 'blocklist', apps: ['837'] } } });
    await h.tick(0);
    for (let i = 0; i < 3; i++) {
      h.tv.remote({ launch: '837' });
      await h.tick(3 * 60 * SEC); // 3 minutes apart: never 3 within 5 minutes
    }
    expect(h.keys()).toEqual(['Home', 'Home', 'Home']);
  });

  it('quiet hours power the TV off, even on the Home screen', async () => {
    const h = await setup({ rules: { quietHours: ['20:30-07:00'] } }, { start: '2026-09-30T20:29:50' });
    await h.tick(0);
    expect(h.keys()).toEqual([]);
    await h.tick(10 * SEC); // 20:30:00
    expect(h.keys()).toEqual(['PowerOff']);
    expect(h.events[0]).toMatchObject({ reason: 'quiet_hours', message: 'Sent PowerOff — Quiet hours (20:30–07:00)' });

    // Kid turns it back on: powered off again, but not more often than the PowerOff cooldown (15 s).
    h.tv.remote({ key: 'PowerOn' });
    await h.tick(5 * SEC);
    expect(h.keys()).toEqual(['PowerOff']);
    await h.tick(10 * SEC);
    expect(h.keys()).toEqual(['PowerOff', 'PowerOff']);
  });

  it('per-app budget: Home exactly when the limit is reached; bonus time lets them continue', async () => {
    const h = await setup({ rules: { appBudgets: { '12': 1 } } }, { initial: { initial: { activeAppId: '12' } } });
    await h.tick(0); // session opens
    for (let i = 0; i < 11; i++) await h.tick(); // 55 s counted
    expect(h.keys()).toEqual([]);
    expect(h.g.enforcer.getLastDecision()?.remainingMs.app).toBe(5 * SEC);
    await h.tick(); // 60 s → limit reached
    expect(h.keys()).toEqual(['Home']);
    expect(h.events[0]?.reason).toBe('app_budget');

    h.g.repos.overrides.addBonus('2026-09-30', 1, h.clock.now());
    h.tv.remote({ launch: '12' });
    await h.tick(20 * SEC);
    expect(h.keys()).toEqual(['Home']);
    expect(h.g.enforcer.getLastDecision()).toMatchObject({ action: 'none', remainingMs: { app: 60 * SEC } });
  });

  it('pause allows everything; lock keeps the TV off', async () => {
    const h = await setup(
      { rules: { appPolicy: { mode: 'allowlist', apps: [] } } },
      { initial: { initial: { activeAppId: '12' } } },
    );
    h.g.repos.overrides.set({ kind: 'pause', until: h.clock.now() + 60 * 60 * SEC, setAt: h.clock.now(), note: null });
    await h.tick(0);
    await h.tick();
    expect(h.keys()).toEqual([]);
    expect(h.g.enforcer.getLastDecision()?.paused).toBe(true);

    h.g.repos.overrides.set({ kind: 'lock', until: null, setAt: h.clock.now(), note: null });
    await h.tick();
    expect(h.keys()).toEqual(['PowerOff']);
    expect(h.events[0]?.reason).toBe('lock');

    h.g.repos.overrides.clear();
    h.tv.remote({ key: 'PowerOn' });
    await h.tick(20 * SEC); // back to rules: Home screen is fine even with an empty allowlist
    expect(h.keys()).toEqual(['PowerOff']);
  });

  it('dry-run logs what it would do and never touches the TV; off does nothing', async () => {
    const h = await setup(
      { rules: { appPolicy: { mode: 'blocklist', apps: ['837'] } }, enforcement: { mode: 'dry-run' } },
      { initial: { initial: { activeAppId: '837' } } },
    );
    await h.tick(0);
    expect(h.keys()).toEqual([]);
    expect(h.tv.state.activeAppId).toBe('837');
    expect(h.events[0]).toMatchObject({
      result: 'dry-run',
      message: 'Practice mode: would send Home — YouTube is blocked',
    });

    const off = await setup(
      { rules: { appPolicy: { mode: 'blocklist', apps: ['837'] } }, enforcement: { mode: 'off' } },
      { initial: { initial: { activeAppId: '837' } } },
    );
    await off.tick(0);
    expect(off.keys()).toEqual([]);
    expect(off.events).toEqual([]);
    expect(off.g.enforcer.getLastDecision()?.action).toBe('home'); // still evaluated, for status
  });

  it('a 403 on the keypress (Limited mode) is logged as failed and flags the health', async () => {
    const h = await setup(
      { rules: { appPolicy: { mode: 'blocklist', apps: ['837'] } } },
      { initial: { initial: { activeAppId: '837', access: 'limited' } } },
    );
    await h.tick(0);
    expect(h.events[0]).toMatchObject({ result: 'failed', action: 'home' });
    expect(h.events[0]?.error).toMatch(/403/);
    expect(h.g.poller.getStatus()).toMatchObject({ health: 'restricted', restriction: 'limited' });
    expect(h.tv.state.activeAppId).toBe('837');
  });
});
