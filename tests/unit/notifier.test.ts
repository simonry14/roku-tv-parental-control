import { beforeEach, describe, expect, it } from 'vitest';
import { NotificationsConfigSchema, type NotificationsConfig } from '../../src/config/schema.js';
import type { EnforcementEvent } from '../../src/enforce/enforcer.js';
import { GuardianBus } from '../../src/lib/bus.js';
import { silentLogger } from '../../src/lib/logger.js';
import type { LiveStatus } from '../../src/monitor/status.js';
import { Notifier } from '../../src/notify/notifier.js';
import { NtfyClient, type FetchLike } from '../../src/notify/ntfy.js';
import { fakeClock, MIN, type FakeClock } from '../helpers.js';

let clock: FakeClock;
let pushes: Array<{ url: string; body: Record<string, unknown>; auth?: string }>;
let cfg: NotificationsConfig;
let notifier: Notifier;

const fetchImpl: FetchLike = async (url, init) => {
  pushes.push({
    url,
    body: JSON.parse(init.body) as Record<string, unknown>,
    ...(init.headers.Authorization ? { auth: init.headers.Authorization } : {}),
  });
  return { ok: true, status: 200, text: async () => '' };
};

beforeEach(() => {
  clock = fakeClock();
  pushes = [];
  cfg = NotificationsConfigSchema.parse({
    ntfy: { enabled: true, topic: 'kids-tv-7f3a9c', server: 'https://ntfy.example/' },
  });
  const ntfy = new NtfyClient(() => cfg.ntfy, 'tk_secret', silentLogger(), fetchImpl);
  notifier = new Notifier({
    bus: new GuardianBus(),
    ntfy,
    getConfig: () => cfg,
    clock,
    zone: 'America/New_York',
    logger: silentLogger(),
  });
});

const enf = (over: Partial<EnforcementEvent> = {}): EnforcementEvent => ({
  at: clock.now(),
  action: 'home',
  reason: 'app_blocked',
  escalatedFrom: null,
  message: 'Sent Home — YouTube is blocked',
  appId: '837',
  appName: 'YouTube',
  mode: 'enforce',
  result: 'sent',
  error: null,
  shown: null,
  pendingUntil: null,
  afterCountdown: false,
  ...over,
});

const status = (over: Partial<LiveStatus>): LiveStatus => ({
  health: 'online',
  healthSince: clock.now(),
  restriction: null,
  message: '',
  device: null,
  powerMode: null,
  activity: null,
  lastPollAt: null,
  lastSuccessAt: null,
  consecutiveFailures: 0,
  pollIntervalMs: 5000,
  lastError: null,
  ...over,
});

describe('Notifier', () => {
  it('publishes JSON to the server root with the topic and bearer token', async () => {
    await notifier.handleEnforcement(enf());
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({
      url: 'https://ntfy.example',
      auth: 'Bearer tk_secret',
      body: {
        topic: 'kids-tv-7f3a9c',
        title: 'Blocked app opened',
        message: 'YouTube was opened and sent back to Home.',
      },
    });
  });

  it('debounces blocked-app pushes per app for 10 minutes', async () => {
    await notifier.handleEnforcement(enf());
    clock.advance(5 * MIN);
    await notifier.handleEnforcement(enf());
    await notifier.handleEnforcement(enf({ appId: '2285', appName: 'Hulu' }));
    clock.advance(6 * MIN);
    await notifier.handleEnforcement(enf());
    expect(pushes.map((p) => p.body.message)).toEqual([
      'YouTube was opened and sent back to Home.',
      'Hulu was opened and sent back to Home.',
      'YouTube was opened and sent back to Home.',
    ]);
  });

  it('describes escalation and failures', async () => {
    await notifier.handleEnforcement(enf({ action: 'power_off', escalatedFrom: 'app_blocked' }));
    await notifier.handleEnforcement(enf({ appId: '12', appName: 'Netflix', result: 'failed', error: 'HTTP 403' }));
    expect(pushes[0]?.body).toMatchObject({
      title: 'TV turned off',
      message: 'YouTube kept being reopened, so the TV was turned off.',
    });
    expect(pushes[1]?.body.message).toBe(
      'Netflix was opened and sent back to Home — but the TV could not be controlled: HTTP 403.',
    );
  });

  it('budget exhausted: once per app per day', async () => {
    const e = enf({
      reason: 'app_budget',
      appId: '44444',
      appName: 'YouTube Kids',
      message: 'Sent Home — YouTube Kids: daily limit of 60 min reached',
    });
    await notifier.handleEnforcement(e);
    clock.advance(60 * MIN);
    await notifier.handleEnforcement({ ...e, at: clock.now() });
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.body).toMatchObject({
      title: "Time's up",
      message: 'YouTube Kids: daily limit of 60 min reached.',
    });
  });

  it('skips dry-run actions unless asked, and respects per-event toggles', async () => {
    await notifier.handleEnforcement(enf({ mode: 'dry-run', result: 'dry-run' }));
    expect(pushes).toHaveLength(0);
    cfg = { ...cfg, includeDryRun: true };
    await notifier.handleEnforcement(enf({ mode: 'dry-run', result: 'dry-run' }));
    expect(pushes[0]?.body.title).toBe('Blocked app opened (practice mode)');
    cfg = { ...cfg, events: { ...cfg.events, scheduleViolation: false } };
    await notifier.handleEnforcement(enf({ reason: 'quiet_hours', action: 'power_off' }));
    expect(pushes).toHaveLength(1);
  });

  it('tamper: urgent push when ECP becomes restricted, then "restored"', async () => {
    await notifier.handleHealth({
      at: clock.now(),
      from: 'online',
      to: 'restricted',
      restriction: 'blocked',
      message: 'ECP access denied',
    });
    await notifier.handleHealth({
      at: clock.now(),
      from: 'restricted',
      to: 'online',
      restriction: null,
      message: 'ok',
    });
    expect(pushes.map((p) => [p.body.title, p.body.priority])).toEqual([
      ['TV control blocked — possible tampering', 5],
      ['TV control restored', 3],
    ]);
  });

  it('unreachable: only after the configured time, once per outage', async () => {
    const since = clock.now();
    await notifier.handleObservation({
      at: clock.now(),
      observation: { status: 'unknown', reason: 'unreachable' },
      status: status({ health: 'offline', healthSince: since }),
    });
    clock.advance(31 * MIN);
    const ev = {
      at: clock.now(),
      observation: { status: 'unknown', reason: 'unreachable' } as const,
      status: status({ health: 'offline', healthSince: since }),
    };
    await notifier.handleObservation(ev);
    await notifier.handleObservation({ ...ev, at: clock.now() + MIN });
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.body.message).toMatch(/for 31 minutes/);
    await notifier.handleHealth({ at: clock.now(), from: 'offline', to: 'online', restriction: null, message: '' });
    expect(pushes.at(-1)?.body.title).toBe('TV reachable again');
  });

  it('does nothing when ntfy is disabled or has no topic', async () => {
    cfg = { ...cfg, ntfy: { ...cfg.ntfy, enabled: false } };
    await notifier.handleEnforcement(enf());
    cfg = { ...cfg, ntfy: { ...cfg.ntfy, enabled: true, topic: '' } };
    await notifier.handleEnforcement(enf({ appId: 'x' }));
    expect(pushes).toHaveLength(0);
  });
});
