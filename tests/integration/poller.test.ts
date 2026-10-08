import { afterEach, describe, expect, it } from 'vitest';
import { createGuardian, type Guardian } from '../../src/app.js';
import type { ConfigInput } from '../../src/config/schema.js';
import type { DiscoveredDevice } from '../../src/ecp/discovery.js';
import type { PresenceResult } from '../../src/ecp/reachability.js';
import { silentLogger } from '../../src/lib/logger.js';
import type { HealthChangeEvent } from '../../src/monitor/status.js';
import type { MockRoku } from '../../mock/mock-roku.js';
import { fakeClock, memoryDb, mockRoku, SEC, type FakeClock } from '../helpers.js';
import { testConfig } from '../helpers.js';

const TV_MAC = 'd8:31:34:00:be:ef';

interface Harness {
  g: Guardian;
  clock: FakeClock;
  health: HealthChangeEvent[];
  presence: { value: PresenceResult };
  ssdp: { value: DiscoveredDevice[]; calls: number };
  tick(advanceMs?: number): Promise<void>;
}

const mocks: MockRoku[] = [];
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((m) => m.close()));
});

async function startMock(...args: Parameters<typeof mockRoku>): Promise<MockRoku> {
  const m = await mockRoku(...args);
  mocks.push(m);
  return m;
}

function harness(
  config: ConfigInput,
  opts: { db?: ReturnType<typeof memoryDb>['db']; clock?: FakeClock } = {},
): Harness {
  const clock = opts.clock ?? fakeClock();
  const presence = { value: { alive: false, mac: null } as PresenceResult };
  const ssdp = { value: [] as DiscoveredDevice[], calls: 0 };
  const g = createGuardian(
    testConfig({
      monitor: { pollIntervalSec: 5, requestTimeoutMs: 300, offlineAfterFailures: 2, offlineBackoffMaxSec: 30 },
      discovery: { rediscoverAfterFailures: 3, rediscoverMinIntervalSec: 10, subnetScan: false },
      ...config,
    }),
    silentLogger(),
    {
      clock,
      db: opts.db ?? memoryDb().db,
      reachability: { presence: async () => presence.value },
      ssdp: async () => {
        ssdp.calls++;
        return ssdp.value;
      },
      scan: async () => [],
    },
  );
  const health: HealthChangeEvent[] = [];
  g.bus.on('health', (e) => health.push(e));
  return {
    g,
    clock,
    health,
    presence,
    ssdp,
    tick: async (advanceMs = 5 * SEC) => {
      clock.advance(advanceMs);
      await g.poller.tick();
    },
  };
}

describe('Poller ↔ mock Roku', () => {
  it('pins the TV, tracks sessions through app switches and power-off', async () => {
    const tv = await startMock();
    const h = harness({ device: { host: '127.0.0.1', port: tv.ecpPort } });

    await h.tick(0);
    expect(h.g.repos.devices.pinned()?.serial).toBe('YJ00MOCK0001');
    expect(h.g.poller.getStatus()).toMatchObject({
      health: 'online',
      powerMode: 'PowerOn',
      activity: { kind: 'home' },
    });
    expect(h.g.repos.apps.list().length).toBeGreaterThan(5); // installed apps synced

    tv.remote({ launch: '12' });
    await h.tick();
    await h.tick();
    await h.tick();
    expect(h.g.poller.getStatus().activity).toMatchObject({ kind: 'app', appId: '12', appName: 'Netflix' });

    tv.remote({ launch: 'tvinput.hdmi1' }); // game console on HDMI counts as an app
    await h.tick();
    await h.tick();

    tv.remote({ key: 'PowerOff' });
    await h.tick();
    expect(h.g.poller.getStatus()).toMatchObject({ health: 'tv_off', powerMode: 'DisplayOff', activity: null });

    const today = h.g.usage.forDay(h.clock.now());
    expect(today.byApp).toEqual([
      { appId: '12', appName: 'Netflix', ms: 10 * SEC },
      { appId: 'tvinput.hdmi1', appName: 'Game console', ms: 5 * SEC },
    ]);
    expect(today.homeMs).toBe(0); // home seen once, then Netflix: no confirmed home interval
    expect(h.health.map((e) => `${e.from}→${e.to}`)).toEqual(['starting→online', 'online→tv_off']);
    expect(h.g.repos.sessions.recent().map((s) => s.endReason)).toEqual(['power_off', 'switch', 'switch']);
  });

  it('detects Limited mode via the icon canary while monitoring continues', async () => {
    const tv = await startMock({ initial: { access: 'limited', activeAppId: '837' } });
    const h = harness({ device: { host: '127.0.0.1', port: tv.ecpPort } });

    await h.tick(0);
    const s = h.g.poller.getStatus();
    expect(s).toMatchObject({ health: 'restricted', restriction: 'limited', activity: { appId: '837' } });
    expect(s.message).toMatch(/Limited mode/);

    await h.tick();
    expect(h.g.repos.sessions.getOpen()?.durationMs).toBe(5 * SEC); // still counting

    await tv.set({ access: 'enabled' });
    await h.tick(14 * SEC); // below maxGap; past the 15s Limited re-probe interval (measured from the first tick)
    await h.tick(2 * SEC);
    expect(h.g.poller.getStatus()).toMatchObject({ health: 'online', restriction: null });
  });

  it('real-TV tamper: switching Control by mobile apps to Disabled (403) is flagged on the first poll', async () => {
    const tv = await startMock({ initial: { activeAppId: '12' } });
    const h = harness({ device: { host: '127.0.0.1', port: tv.ecpPort } });
    await h.tick(0);
    await h.tick();

    await tv.set({ access: 'disabled' }); // what the owner's TV does: SSDP still answers, every query → 403
    await h.tick();
    const s = h.g.poller.getStatus();
    expect(s).toMatchObject({ health: 'restricted', restriction: 'blocked' });
    expect(s.message).toMatch(/Disabled/);
    expect(h.health.at(-1)).toMatchObject({ from: 'online', to: 'restricted' });

    for (let i = 0; i < 3; i++) await h.tick(); // unobservable beyond maxGap → session closed
    expect(h.g.repos.sessions.recent()[0]).toMatchObject({ appId: '12', endReason: 'restricted', durationMs: 5 * SEC });
  });

  it('flags "ECP disabled" when port 8060 refuses but the TV is present (ARP MAC match)', async () => {
    const tv = await startMock({ disabledBehavior: 'refuse' });
    const h = harness({ device: { host: '127.0.0.1', port: tv.ecpPort } });
    await h.tick(0);
    expect(h.g.repos.devices.pinned()?.macs).toEqual([TV_MAC]);

    h.presence.value = { alive: true, mac: TV_MAC };
    await tv.set({ access: 'disabled' });
    await h.tick();
    expect(h.g.poller.getStatus().health).toBe('online'); // one failure: not yet
    await h.tick();
    expect(h.g.poller.getStatus()).toMatchObject({ health: 'restricted', restriction: 'disabled' });
    expect(h.ssdp.calls).toBe(0); // MAC proved it's our TV: no need to rediscover first

    await tv.set({ access: 'enabled' });
    await h.tick();
    expect(h.g.poller.getStatus().health).toBe('online');
  });

  it('reports offline (not tamper) when the host is gone, and backs off', async () => {
    const tv = await startMock({ initial: { activeAppId: '12' } });
    const h = harness({ device: { host: '127.0.0.1', port: tv.ecpPort } });
    await h.tick(0);
    await h.tick();

    await tv.set({ offline: true }); // accepts TCP, never answers → timeouts
    await h.tick();
    expect(h.g.poller.getStatus().health).toBe('online');
    expect(h.g.repos.sessions.getOpen()).not.toBeNull(); // transient failure tolerated
    await h.tick();
    const s = h.g.poller.getStatus();
    expect(s.health).toBe('offline');
    expect(s.consecutiveFailures).toBe(2);

    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      await h.tick(h.g.poller.getStatus().pollIntervalMs);
      delays.push(h.g.poller.getStatus().pollIntervalMs);
    }
    expect(delays).toEqual([10 * SEC, 20 * SEC, 30 * SEC, 30 * SEC]); // exponential, capped

    const closed = h.g.repos.sessions.recent()[0]!;
    expect(closed).toMatchObject({ appId: '12', endReason: 'unreachable', durationMs: 5 * SEC }); // ends at last confirmed poll
  });

  it('pins a TV found by SSDP even when it refuses ECP (403), and reports restricted — not "no Roku"', async () => {
    const tv = await startMock({ disabledBehavior: '403', initial: { access: 'disabled' } });
    const h = harness({}); // fresh install: no host, nothing pinned
    h.ssdp.value = [{ serial: 'YJ00MOCK0001', host: '127.0.0.1', port: tv.ecpPort, via: 'ssdp' }];

    await h.tick(0);
    expect(h.g.repos.devices.pinned()?.serial).toBe('YJ00MOCK0001');
    const s = h.g.poller.getStatus();
    expect(s).toMatchObject({ health: 'restricted', restriction: 'blocked', device: { host: '127.0.0.1' } });
    expect(s.message).toMatch(/Control by mobile apps/);

    await tv.set({ access: 'enabled' }); // parent fixes the TV setting
    await h.tick();
    expect(h.g.poller.getStatus()).toMatchObject({ health: 'online', device: { name: 'Living Room TV (mock)' } });
  });

  it('pins an SSDP-announced TV whose port 8060 is closed and flags "ECP disabled"', async () => {
    const tv = await startMock({ disabledBehavior: 'refuse', initial: { access: 'disabled' } }); // port closed
    const h = harness({});
    h.ssdp.value = [{ serial: 'YJ00MOCK0001', host: '127.0.0.1', port: tv.ecpPort, via: 'ssdp' }];
    await h.tick(0);
    expect(h.g.repos.devices.pinned()?.serial).toBe('YJ00MOCK0001');
    await h.tick();
    expect(h.g.poller.getStatus()).toMatchObject({ health: 'restricted', restriction: 'disabled' });
  });

  it('follows the TV to a new address by serial (DHCP change) without a false tamper alarm', async () => {
    const a = await startMock();
    const h = harness({}); // no manual host: discovery + pinning
    h.ssdp.value = [{ serial: 'YJ00MOCK0001', host: '127.0.0.1', port: a.ecpPort, via: 'ssdp' }];
    await h.tick(0);
    expect(h.g.poller.getTarget()?.port).toBe(a.ecpPort);

    // TV gets a new lease; the old address is now some other live device (no port 8060, unknown MAC).
    await a.close();
    const b = await startMock();
    h.ssdp.value = [{ serial: 'YJ00MOCK0001', host: '127.0.0.1', port: b.ecpPort, via: 'ssdp' }];
    h.presence.value = { alive: true, mac: null };

    await h.tick(); // 1st refusal: below the alarm threshold
    await h.tick(); // 2nd: would raise "ECP disabled", but rediscovery finds the TV elsewhere first
    expect(h.g.poller.getTarget()?.port).toBe(b.ecpPort);
    await h.tick();
    expect(h.g.poller.getStatus().health).toBe('online');
    expect(h.health.some((e) => e.to === 'restricted')).toBe(false);
    const moved = h.g.repos.events.recent({ type: 'device' }).find((e) => e.message.includes('address changed'));
    expect(moved).toBeDefined();
  });

  it('never tracks a different Roku that appears at the pinned address', async () => {
    const a = await startMock();
    const h = harness({ device: { host: '127.0.0.1', port: a.ecpPort } });
    await h.tick(0);
    const port = a.ecpPort;
    await a.close();
    await startMock({ ecpPort: port, initial: { serial: 'OTHER000001', activeAppId: '12' } });

    for (let i = 0; i < 4; i++) await h.tick();
    const s = h.g.poller.getStatus();
    expect(['offline', 'searching']).toContain(s.health);
    expect(h.g.repos.sessions.recent().every((x) => x.deviceSerial === 'YJ00MOCK0001')).toBe(true);
    expect(h.g.repos.devices.pinned()?.serial).toBe('YJ00MOCK0001');
  });

  it('continues a session across a quick restart; recovers a stale one', async () => {
    const tv = await startMock({ initial: { activeAppId: '12' } });
    const { db } = memoryDb();
    const clock = fakeClock();
    const cfg = { device: { host: '127.0.0.1', port: tv.ecpPort } };

    const first = harness(cfg, { db, clock });
    await first.tick(0);
    await first.tick();

    const second = harness(cfg, { db, clock });
    expect(second.g.tracker.recover(clock.now() + 3 * SEC)).toBeNull();
    await second.tick(8 * SEC);
    expect(second.g.repos.sessions.recent()).toHaveLength(1);
    expect(second.g.repos.sessions.getOpen()?.durationMs).toBe(13 * SEC);

    const third = harness(cfg, { db, clock });
    clock.advance(10 * 60 * SEC);
    expect(third.g.tracker.recover(clock.now())).toMatchObject({ endReason: 'recovered', durationMs: 13 * SEC });
  });
});
