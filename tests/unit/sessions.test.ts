import { beforeEach, describe, expect, it } from 'vitest';
import type { Repos } from '../../src/db/repo.js';
import type { Observation } from '../../src/monitor/observation.js';
import { planSessionOps, SessionTracker, type OpenSessionView } from '../../src/monitor/sessions.js';
import { memoryDb, SEC } from '../helpers.js';

const SERIAL = 'TV1';
const MAX_GAP = 15 * SEC;

const app = (id: string, name = id): Observation => ({
  status: 'watching',
  deviceSerial: SERIAL,
  kind: 'app',
  appId: id,
  appName: name,
  appType: 'appl',
});
const home: Observation = {
  status: 'watching',
  deviceSerial: SERIAL,
  kind: 'home',
  appId: null,
  appName: 'Home',
  appType: null,
};
const saver: Observation = {
  status: 'watching',
  deviceSerial: SERIAL,
  kind: 'screensaver',
  appId: '55545',
  appName: 'Roku City',
  appType: 'ssvr',
};
const off: Observation = { status: 'off', deviceSerial: SERIAL, powerMode: 'DisplayOff' };
const unreachable: Observation = { status: 'unknown', reason: 'unreachable' };
const restricted: Observation = { status: 'unknown', reason: 'restricted' };

const openView = (over: Partial<OpenSessionView> = {}): OpenSessionView => ({
  id: 1,
  deviceSerial: SERIAL,
  kind: 'app',
  appId: '12',
  lastSeenAt: 100 * SEC,
  ...over,
});

describe('planSessionOps (pure)', () => {
  const plan = (open: OpenSessionView | null, obs: Observation, now: number) =>
    planSessionOps(open, obs, now, { maxGapMs: MAX_GAP });

  it('opens a session on first sight', () => {
    expect(plan(null, app('12'), 5 * SEC)).toEqual([
      { op: 'open', session: { deviceSerial: SERIAL, kind: 'app', appId: '12', appName: '12', startedAt: 5 * SEC } },
    ]);
  });

  it('extends the same activity within the gap', () => {
    expect(plan(openView(), app('12'), 105 * SEC)).toEqual([{ op: 'touch', id: 1, lastSeenAt: 105 * SEC }]);
  });

  it('closes and opens on app switch', () => {
    const ops = plan(openView(), app('837'), 105 * SEC);
    expect(ops[0]).toEqual({ op: 'close', id: 1, reason: 'switch' });
    expect(ops[1]).toMatchObject({ op: 'open', session: { appId: '837', startedAt: 105 * SEC } });
  });

  it('treats Home and screensaver as distinct activities', () => {
    expect(plan(openView(), home, 105 * SEC).map((o) => o.op)).toEqual(['close', 'open']);
    expect(plan(openView({ kind: 'home', appId: null }), saver, 105 * SEC).map((o) => o.op)).toEqual(['close', 'open']);
  });

  it('closes on power off, does nothing when already closed', () => {
    expect(plan(openView(), off, 105 * SEC)).toEqual([{ op: 'close', id: 1, reason: 'power_off' }]);
    expect(plan(null, off, 105 * SEC)).toEqual([]);
    expect(plan(null, unreachable, 105 * SEC)).toEqual([]);
  });

  it('tolerates a transient failure (session stays open, not extended)', () => {
    expect(plan(openView(), unreachable, 110 * SEC)).toEqual([]);
  });

  it('closes with the failure reason once unobserved longer than maxGap', () => {
    expect(plan(openView(), unreachable, 116 * SEC)).toEqual([{ op: 'close', id: 1, reason: 'unreachable' }]);
    expect(plan(openView(), restricted, 200 * SEC)).toEqual([{ op: 'close', id: 1, reason: 'restricted' }]);
  });

  it('does not bridge a gap even if the same app is still on (PC slept)', () => {
    const ops = plan(openView(), app('12'), 400 * SEC);
    expect(ops[0]).toEqual({ op: 'close', id: 1, reason: 'gap' });
    expect(ops[1]).toMatchObject({ op: 'open', session: { appId: '12', startedAt: 400 * SEC } });
  });

  it('treats a clock jump backwards as a gap', () => {
    expect(plan(openView(), app('12'), 50 * SEC).map((o) => o.op)).toEqual(['close', 'open']);
  });

  it('treats a different TV as a switch', () => {
    const obs: Observation = { ...(app('12') as Extract<Observation, { status: 'watching' }>), deviceSerial: 'TV2' };
    expect(plan(openView(), obs, 105 * SEC).map((o) => o.op)).toEqual(['close', 'open']);
  });
});

describe('SessionTracker (SQLite)', () => {
  let repos: Repos;
  let tracker: SessionTracker;

  beforeEach(() => {
    repos = memoryDb().repos;
    tracker = new SessionTracker(repos, { maxGapMs: MAX_GAP });
  });

  it('counts only time confirmed by consecutive polls', () => {
    tracker.observe(app('12', 'Netflix'), 0);
    tracker.observe(app('12', 'Netflix'), 5 * SEC);
    tracker.observe(app('12', 'Netflix'), 10 * SEC);
    tracker.observe(app('837', 'YouTube'), 15 * SEC); // switch happened somewhere in (10, 15]
    tracker.observe(app('837', 'YouTube'), 20 * SEC);
    tracker.observe(off, 25 * SEC);

    const [yt, nf] = repos.sessions.recent();
    expect(nf).toMatchObject({
      appId: '12',
      startedAt: 0,
      endedAt: 10 * SEC,
      durationMs: 10 * SEC,
      endReason: 'switch',
    });
    expect(yt).toMatchObject({
      appId: '837',
      startedAt: 15 * SEC,
      endedAt: 20 * SEC,
      durationMs: 5 * SEC,
      endReason: 'power_off',
    });
    expect(repos.sessions.getOpen()).toBeNull();
  });

  it('bridges a single failed poll', () => {
    tracker.observe(app('12'), 0);
    tracker.observe(app('12'), 5 * SEC);
    tracker.observe(unreachable, 10 * SEC);
    tracker.observe(app('12'), 15 * SEC);
    const sessions = repos.sessions.recent();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ endedAt: null, lastSeenAt: 15 * SEC, durationMs: 15 * SEC });
  });

  it('closes at the last confirmed poll when the TV disappears', () => {
    tracker.observe(app('12'), 0);
    tracker.observe(app('12'), 5 * SEC);
    tracker.observe(unreachable, 10 * SEC);
    tracker.observe(unreachable, 20 * SEC);
    const change = tracker.observe(unreachable, 30 * SEC);
    expect(change.closed[0]).toMatchObject({ endedAt: 5 * SEC, durationMs: 5 * SEC, endReason: 'unreachable' });
    tracker.observe(app('12'), 40 * SEC);
    expect(repos.sessions.recent()).toHaveLength(2);
  });

  it('recovers a stale open session on restart, continues a fresh one', () => {
    tracker.observe(app('12'), 0);
    tracker.observe(app('12'), 5 * SEC);

    // Quick restart (within maxGap): nothing to recover, the next poll continues the session.
    const fresh = new SessionTracker(repos, { maxGapMs: MAX_GAP });
    expect(fresh.recover(12 * SEC)).toBeNull();
    fresh.observe(app('12'), 12 * SEC);
    expect(repos.sessions.recent()).toHaveLength(1);
    expect(repos.sessions.getOpen()?.durationMs).toBe(12 * SEC);

    // Long outage: recovered at its last confirmed poll.
    const later = new SessionTracker(repos, { maxGapMs: MAX_GAP });
    const recovered = later.recover(10 * 60 * SEC);
    expect(recovered).toMatchObject({ endedAt: 12 * SEC, endReason: 'recovered', durationMs: 12 * SEC });
    expect(repos.sessions.getOpen()).toBeNull();
  });

  it('the database refuses a second open session', () => {
    repos.sessions.open({ deviceSerial: SERIAL, kind: 'app', appId: '12', appName: 'Netflix', startedAt: 0 });
    expect(() =>
      repos.sessions.open({ deviceSerial: SERIAL, kind: 'home', appId: null, appName: 'Home', startedAt: 1 }),
    ).toThrow(/UNIQUE/);
  });

  it('close is idempotent and touch is monotonic', () => {
    const id = repos.sessions.open({
      deviceSerial: SERIAL,
      kind: 'app',
      appId: '12',
      appName: 'Netflix',
      startedAt: 0,
    });
    repos.sessions.touch(id, 10 * SEC);
    repos.sessions.touch(id, 5 * SEC);
    expect(repos.sessions.get(id)?.lastSeenAt).toBe(10 * SEC);
    repos.sessions.close(id, 'switch');
    repos.sessions.close(id, 'gap');
    repos.sessions.touch(id, 20 * SEC);
    expect(repos.sessions.get(id)).toMatchObject({ endedAt: 10 * SEC, endReason: 'switch', lastSeenAt: 10 * SEC });
  });

  it('randomised: never overlaps, never counts unobserved time (property test)', () => {
    let seed = 42;
    const rand = (): number => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const choices: Observation[] = [
      app('12'),
      app('837'),
      app('tvinput.hdmi1'),
      home,
      saver,
      off,
      unreachable,
      restricted,
    ];

    let t = 0;
    let expected = 0;
    let lastOk: { obs: Observation; at: number } | null = null;

    for (let i = 0; i < 3000; i++) {
      t += Math.floor(1 + rand() * 25) * SEC;
      // Sticky activity: usually repeat, sometimes change.
      const obs: Observation =
        lastOk && rand() < 0.7 && lastOk.obs.status === 'watching'
          ? lastOk.obs
          : choices[Math.floor(rand() * choices.length)]!;
      tracker.observe(obs, t);

      // Reference model: time between consecutive *successful* polls with the same activity, ≤ maxGap apart.
      if (obs.status === 'unknown') {
        if (lastOk && t - lastOk.at > MAX_GAP) lastOk = null;
        continue;
      }
      if (lastOk && obs.status === 'watching' && lastOk.obs.status === 'watching' && t - lastOk.at <= MAX_GAP) {
        const a = lastOk.obs;
        if (a.kind === obs.kind && a.appId === obs.appId) expected += t - lastOk.at;
      }
      lastOk = { obs, at: t };
    }

    const all = repos.sessions.recent(100_000).sort((a, b) => a.startedAt - b.startedAt);
    const total = all.reduce((sum, s) => sum + s.durationMs, 0);
    expect(total).toBe(expected);
    for (let i = 1; i < all.length; i++) {
      const prevEnd = all[i - 1]!.endedAt ?? all[i - 1]!.lastSeenAt;
      expect(all[i]!.startedAt).toBeGreaterThan(prevEnd); // strictly after: no overlap, no shared instant
    }
    expect(all.filter((s) => s.endedAt === null).length).toBeLessThanOrEqual(1);
  });
});
