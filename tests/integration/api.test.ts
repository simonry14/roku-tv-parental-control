import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { StatusDto } from '../../src/api/contract.js';
import { buildApi } from '../../src/api/server.js';
import { createGuardian, type Guardian } from '../../src/app.js';
import type { ConfigInput } from '../../src/config/schema.js';
import { silentLogger } from '../../src/lib/logger.js';
import type { FetchLike } from '../../src/notify/ntfy.js';
import type { MockRoku } from '../../mock/mock-roku.js';
import { fakeClock, memoryDb, mockRoku, SEC, testConfig } from '../helpers.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Ctx {
  tv: MockRoku;
  g: Guardian;
  app: FastifyInstance;
  pushes: Array<Record<string, unknown>>;
  cookie: string;
  tick(ms?: number): Promise<void>;
  req(
    method: string,
    url: string,
    body?: unknown,
    extra?: { cookie?: string | null; remoteAddress?: string; contentType?: string },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are asserted field by field
  ): Promise<{ status: number; json: any; headers: Record<string, unknown>; body: string }>;
  login(pin?: string): Promise<string>;
}

async function setup(
  config: ConfigInput = {},
  opts: { loginRateLimit?: number; initial?: Parameters<typeof mockRoku>[0] } = {},
): Promise<Ctx> {
  // Without the Parental Control channel unless a test installs it (tv-messages.test.ts covers it).
  const tv = await mockRoku({
    ...opts.initial,
    initial: { devChannelInstalled: false, ...opts.initial?.initial },
  });
  cleanups.push(() => tv.close());
  const pushes: Array<Record<string, unknown>> = [];
  const ntfyFetch: FetchLike = async (_url, init) => {
    pushes.push(JSON.parse(init.body) as Record<string, unknown>);
    return { ok: true, status: 200, text: async () => '' };
  };
  const clock = fakeClock();
  const g = createGuardian(
    testConfig({
      device: { host: '127.0.0.1', port: tv.ecpPort },
      monitor: { pollIntervalSec: 5, requestTimeoutMs: 500, restrictionProbeIntervalSec: 0 },
      enforcement: { mode: 'enforce' },
      notifications: { ntfy: { enabled: true, topic: 'rg-test-topic' } },
      ...config,
    }),
    silentLogger(),
    {
      clock,
      db: memoryDb().db,
      reachability: { presence: async () => ({ alive: true, mac: null }) },
      ssdp: async () => [],
      scan: async () => [],
      ntfyFetch,
      http: false,
    },
  );
  const app = await buildApi({
    guardian: g,
    auth: g.auth,
    icons: g.icons,
    notifier: g.notifier,
    logger: silentLogger(),
    webRoot: null,
    ...(opts.loginRateLimit ? { loginRateLimit: opts.loginRateLimit } : {}),
  });
  cleanups.push(() => app.close());

  const ctx: Ctx = {
    tv,
    g,
    app,
    pushes,
    cookie: '',
    tick: async (ms = 5 * SEC) => {
      clock.advance(ms);
      await g.poller.tick();
      await g.enforcer.idle();
    },
    req: async (method, url, body, extra = {}) => {
      const cookie = extra.cookie === undefined ? ctx.cookie : extra.cookie;
      const res = await app.inject({
        method: method as 'GET',
        url,
        ...(body !== undefined ? { payload: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
        headers: {
          ...(body !== undefined ? { 'content-type': extra.contentType ?? 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
        },
        ...(extra.remoteAddress ? { remoteAddress: extra.remoteAddress } : {}),
      });
      let json: unknown = null;
      try {
        json = res.json();
      } catch {
        /* not JSON */
      }
      return { status: res.statusCode, json, headers: res.headers, body: res.body };
    },
    login: async (pin = '482913') => {
      const res = await ctx.req('POST', '/api/auth/login', { pin }, { cookie: null });
      expect(res.status).toBe(200);
      const set = String(res.headers['set-cookie']);
      expect(set).toMatch(/HttpOnly/i);
      expect(set).toMatch(/SameSite=Strict/i);
      ctx.cookie = set.split(';')[0]!;
      return ctx.cookie;
    },
  };
  return ctx;
}

describe('auth & guards', () => {
  it('requires a PIN created on the PC, then a session cookie', async () => {
    const c = await setup();
    expect((await c.req('GET', '/api/health')).json).toMatchObject({ ok: true });
    expect((await c.req('GET', '/api/status')).status).toBe(401);
    expect((await c.req('GET', '/api/auth/state')).json).toEqual({
      pinSet: false,
      authenticated: false,
      lockedUntil: null,
    });
    expect((await c.req('POST', '/api/auth/login', { pin: '1234' })).status).toBe(409);

    await c.g.auth.setPin('482913');
    expect((await c.req('POST', '/api/auth/login', { pin: '000000' })).status).toBe(401);
    await c.login();
    expect((await c.req('GET', '/api/auth/state')).json).toMatchObject({ pinSet: true, authenticated: true });
    expect((await c.req('GET', '/api/status')).status).toBe(200);

    await c.req('POST', '/api/auth/logout', {});
    expect((await c.req('GET', '/api/status')).status).toBe(401);
  });

  it('rejects non-LAN clients and non-JSON mutations', async () => {
    const c = await setup();
    await c.g.auth.setPin('482913');
    await c.login();
    expect((await c.req('GET', '/api/health', undefined, { remoteAddress: '8.8.8.8' })).status).toBe(403);
    expect((await c.req('GET', '/api/status', undefined, { remoteAddress: '192.168.1.40' })).status).toBe(200);
    expect((await c.req('POST', '/api/actions/resume', 'x', { contentType: 'text/plain' })).status).toBe(415);
  });

  it('rate-limits logins per IP and locks out after 10 wrong PINs (with a notification)', async () => {
    const c = await setup();
    await c.g.auth.setPin('482913');
    const codes: number[] = [];
    for (let i = 0; i < 6; i++)
      codes.push((await c.req('POST', '/api/auth/login', { pin: '1111' }, { cookie: null })).status);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);

    const d = await setup({}, { loginRateLimit: 100 });
    await d.g.auth.setPin('482913');
    for (let i = 0; i < 9; i++) await d.req('POST', '/api/auth/login', { pin: '1111' }, { cookie: null });
    const tenth = await d.req('POST', '/api/auth/login', { pin: '1111' }, { cookie: null });
    expect(tenth.status).toBe(429);
    const correct = await d.req('POST', '/api/auth/login', { pin: '482913' }, { cookie: null });
    expect(correct.status).toBe(429); // locked even with the right PIN
    await new Promise((r) => setTimeout(r, 20));
    expect(d.pushes.at(-1)).toMatchObject({ title: 'Dashboard locked', topic: 'rg-test-topic' });
  });

  it('changing the PIN signs out other devices but keeps this one', async () => {
    const c = await setup();
    await c.g.auth.setPin('482913');
    const other = await c.login();
    const mine = await c.login();
    expect((await c.req('POST', '/api/settings/pin', { current: '000000', next: '135792' })).status).toBe(403);
    const res = await c.req('POST', '/api/settings/pin', { current: '482913', next: '135792' }, { cookie: mine });
    expect(res.status).toBe(200);
    const fresh = String(res.headers['set-cookie']).split(';')[0]!;
    expect((await c.req('GET', '/api/status', undefined, { cookie: other })).status).toBe(401);
    expect((await c.req('GET', '/api/status', undefined, { cookie: fresh })).status).toBe(200);
  });
});

describe('dashboard API', () => {
  async function ready(config: ConfigInput = {}, initial?: Parameters<typeof mockRoku>[0]): Promise<Ctx> {
    const c = await setup(config, initial ? { initial } : {});
    await c.g.auth.setPin('482913');
    await c.login();
    return c;
  }

  it('status reflects the TV, the current app and today’s usage', async () => {
    const c = await ready(
      { rules: { appBudgets: { '12': 30 }, globalBudget: 120 } },
      { initial: { activeAppId: '12' } },
    );
    await c.tick(0);
    await c.tick();
    await c.tick();
    const s = (await c.req('GET', '/api/status')).json as StatusDto;
    expect(s.health.state).toBe('online');
    expect(s.tv).toMatchObject({ name: 'Living Room TV (mock)', power: 'PowerOn' });
    expect(s.current).toMatchObject({ kind: 'app', appId: '12', appName: 'Netflix', iconUrl: '/api/apps/12/icon' });
    expect(s.today).toMatchObject({
      screenMs: 10 * SEC,
      budgetMs: 120 * 60 * SEC,
      remainingMs: 120 * 60 * SEC - 10 * SEC,
    });
    expect(s.today.byApp[0]).toMatchObject({ appId: '12', ms: 10 * SEC, budgetMs: 30 * 60 * SEC });
    expect(s.enforcement.mode).toBe('enforce');
    expect(s.decision).toMatchObject({ action: 'none' });
  });

  it('rules: read, validate, save (applies immediately), reset', async () => {
    const c = await ready({}, { initial: { activeAppId: '12' } });
    await c.tick(0);
    const initial = (await c.req('GET', '/api/rules')).json;
    expect(initial.source).toBe('config.json');
    expect(initial.rules.appPolicy).toEqual({ mode: 'blocklist', apps: [] });

    const bad = await c.req('PUT', '/api/rules', {
      rules: { ...initial.rules, quietHours: [{ window: '25:00-07:00' }] },
    });
    expect(bad.status).toBe(400);
    expect(bad.json.details).toMatch(/Invalid time/);

    const next = { ...initial.rules, appPolicy: { mode: 'blocklist', apps: ['12'] } };
    const saved = await c.req('PUT', '/api/rules', { rules: next });
    expect(saved.json).toMatchObject({ source: 'dashboard', rules: { appPolicy: { apps: ['12'] } } });

    await c.tick();
    expect(c.tv.history.map((h) => h.path)).toContain('/keypress/Home'); // enforcer used the new rules

    const reset = await c.req('DELETE', '/api/rules');
    expect(reset.json.source).toBe('config.json');
    expect(c.g.runtime.rules.appPolicy.apps).toEqual([]);
  });

  it('quick actions: lock (immediate PowerOff), resume, pause, bonus, home', async () => {
    const c = await ready({}, { initial: { activeAppId: '12' } });
    await c.tick(0);

    expect((await c.req('POST', '/api/actions/lock', {})).json.message).toMatch(
      /TV locked until turned off — TV turned off/,
    );
    expect(c.tv.state.power).toBe('DisplayOff');
    expect(c.g.repos.overrides.get()?.kind).toBe('lock');
    expect((await c.req('GET', '/api/status')).json.override).toMatchObject({ kind: 'lock', until: null });

    expect((await c.req('POST', '/api/actions/resume', {})).json.message).toBe('TV unlocked');
    expect(c.g.repos.overrides.get()).toBeNull();

    await c.req('POST', '/api/actions/pause', { minutes: 30 });
    expect(c.g.repos.overrides.get()).toMatchObject({ kind: 'pause' });

    expect((await c.req('POST', '/api/actions/bonus', { minutes: 15 })).json.message).toBe(
      'Bonus +15 min (today: 15 min)',
    );
    expect((await c.req('POST', '/api/actions/bonus', { minutes: 0 })).status).toBe(400);
    expect((await c.req('GET', '/api/status')).json.today.bonusMinutes).toBe(15);

    c.tv.remote({ launch: '837' });
    await c.req('POST', '/api/actions/home', {});
    expect(c.tv.state.activeAppId).toBeNull();

    const events = (await c.req('GET', '/api/events?type=override')).json as Array<{ message: string }>;
    expect(events.map((e) => e.message)).toEqual(
      expect.arrayContaining(['TV unlocked', 'Bonus +15 min (today: 15 min)']),
    );
  });

  it('usage history, apps with rules, and icons (TV icon cached; placeholder fallback)', async () => {
    const c = await ready(
      { rules: { appPolicy: { mode: 'blocklist', apps: ['2285'] }, appBudgets: { '44444': 60 } } },
      { initial: { activeAppId: '12' } },
    );
    await c.tick(0);
    await c.tick();
    const days = (await c.req('GET', '/api/usage?days=7')).json as Array<{ day: string; screenMs: number }>;
    expect(days).toHaveLength(7);
    expect(days.at(-1)).toMatchObject({ day: '2026-09-30', screenMs: 5 * SEC });

    const apps = (await c.req('GET', '/api/apps')).json as Array<{
      appId: string;
      rule: string;
      budgetMinutes: number | null;
    }>;
    expect(apps.find((a) => a.appId === '2285')?.rule).toBe('blocked');
    expect(apps.find((a) => a.appId === '44444')?.budgetMinutes).toBe(60);
    expect(apps.some((a) => a.appId === 'dev')).toBe(false);

    const icon = await c.req('GET', '/api/apps/12/icon');
    expect(icon.headers['content-type']).toMatch(/image\/svg\+xml/);
    expect(icon.body).toContain('>N</text>'); // the mock TV's Netflix tile, not our placeholder
    expect(icon.headers['cache-control']).toBe('private, max-age=86400');
    await c.tv.set({ offline: true });
    expect((await c.req('GET', '/api/apps/12/icon')).headers['cache-control']).toBe('private, max-age=86400'); // from cache
    const missing = await c.req('GET', '/api/apps/nope/icon');
    expect(missing.headers['cache-control']).toBe('private, max-age=60');
  });

  it('settings: live poll interval, validation, device, reset; notification test', async () => {
    const c = await ready();
    const s = (await c.req('GET', '/api/settings')).json;
    expect(s).toMatchObject({
      monitor: { pollIntervalSec: 5 },
      enforcement: { mode: 'enforce' },
      sources: { monitor: 'config.json' },
    });
    expect(s.notifications.tokenConfigured).toBe(false);

    const put = await c.req('PUT', '/api/settings/monitor', { pollIntervalSec: 10 });
    expect(put.json).toMatchObject({ monitor: { pollIntervalSec: 10 }, sources: { monitor: 'dashboard' } });
    expect(c.g.runtime.pollIntervalSec).toBe(10);

    expect((await c.req('PUT', '/api/settings/enforcement', { mode: 'yolo' })).status).toBe(400);
    expect((await c.req('PUT', '/api/settings/nope', {})).status).toBe(404);
    await c.req('PUT', '/api/settings/enforcement', { mode: 'dry-run' });
    expect(c.g.runtime.enforcement.mode).toBe('dry-run');

    await c.req('DELETE', '/api/settings/monitor');
    expect(c.g.runtime.pollIntervalSec).toBe(5);

    expect((await c.req('POST', '/api/notifications/test', {})).status).toBe(200);
    expect(c.pushes.at(-1)).toMatchObject({ title: 'TV Parental Control' });
  });

  it('TV messages: parent message, test message, settings and status (channel installed)', async () => {
    const c = await ready({}, { initial: { activeAppId: '12', devChannelInstalled: true } });
    await c.tick(0);

    let s = (await c.req('GET', '/api/status')).json as StatusDto;
    expect(s.tvMessages).toEqual({ enabled: true, installed: true, showing: false, countdown: null });

    expect((await c.req('POST', '/api/actions/message', { text: '' })).status).toBe(400);
    const sent = await c.req('POST', '/api/actions/message', { text: 'Dinner’s ready!', returnToShow: true });
    expect(sent.json).toEqual({ ok: true, message: 'Message shown on the TV' });
    expect(c.tv.state.activeAppId).toBe('dev');
    expect(Buffer.from(c.tv.state.devMessage!.t!, 'base64url').toString()).toBe('Dinner’s ready!');
    await c.tick();
    s = (await c.req('GET', '/api/status')).json as StatusDto;
    expect(s.tvMessages.showing).toBe(true);
    expect(s.current?.appId).toBe('dev');
    await c.tick(15 * SEC);
    expect(c.tv.state.activeAppId).toBe('12'); // back to the show

    expect((await c.req('POST', '/api/tv-messages/test', {})).json.message).toBe('Test message shown on the TV');

    const settings = (await c.req('GET', '/api/settings')).json;
    expect(settings.tvMessages).toMatchObject({
      enabled: true,
      countdownSec: 30,
      warnBeforeMin: 0,
      installed: true,
      installedVersion: '1.0.0',
      packageVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/),
    });
    expect(settings.sources.tvMessages).toBe('config.json');
    const saved = await c.req('PUT', '/api/settings/tvMessages', {
      ...settings.tvMessages,
      installed: undefined,
      installedVersion: undefined,
      packageVersion: undefined,
      warnBeforeMin: 5,
    });
    expect(saved.status).toBe(200);
    expect(c.g.runtime.tvMessages.warnBeforeMin).toBe(5);
    expect(saved.json.sources.tvMessages).toBe('dashboard');

    // The message editor: rewritten words are validated, saved compactly, and previewed on the TV.
    expect(settings.tvMessages.texts).toEqual({});
    const badTexts = await c.req('PUT', '/api/settings/tvMessages', {
      ...saved.json.tvMessages,
      installed: undefined,
      installedVersion: undefined,
      packageVersion: undefined,
      texts: { app_blocked: { title: 'No {ap}' } },
    });
    expect(badTexts.status).toBe(400);
    expect(badTexts.json.details).toMatch(/\{ap\} can’t be filled in here\. You can use \{app\}\./);
    const withTexts = await c.req('PUT', '/api/settings/tvMessages', {
      ...saved.json.tvMessages,
      installed: undefined,
      installedVersion: undefined,
      packageVersion: undefined,
      texts: { app_blocked: { title: 'No {app} right now', body: 'Pick something else to watch, or ask a parent.' } },
    });
    expect(withTexts.status).toBe(200);
    expect(withTexts.json.tvMessages.texts).toEqual({ app_blocked: { title: 'No {app} right now' } });
    const preview = await c.req('POST', '/api/tv-messages/preview', {
      key: 'quiet_hours',
      texts: { quiet_hours: { title: 'Lights out' } },
    });
    expect(preview.status).toBe(200);
    const shown = c.tv.state.devMessage!;
    expect(Buffer.from(shown.t!, 'base64url').toString()).toBe('Lights out');
    expect(Buffer.from(shown.b!, 'base64url').toString()).toBe('The TV stays off until tomorrow at 7:00 AM.');
    expect(shown).toMatchObject({ cd: '30', ok: '1' }); // a preview can always be closed
    expect((await c.req('POST', '/api/tv-messages/preview', { key: 'nope', texts: {} })).status).toBe(400);
    // Nothing was switched off by the preview's countdown.
    await c.tick(31 * SEC);
    expect(c.tv.history.some((h) => h.path === '/keypress/PowerOff')).toBe(false);

    // TV off → a clear 409.
    await c.tv.set({ power: 'DisplayOff' });
    await c.tick();
    const off = await c.req('POST', '/api/actions/message', { text: 'Hello' });
    expect(off.status).toBe(409);
    expect(off.json.error).toMatch(/TV is off/);
  });

  it('TV messages without the channel: a clear 409 explaining how to install it', async () => {
    const c = await ready({}, { initial: { activeAppId: '12' } });
    await c.tick(0);
    const res = await c.req('POST', '/api/actions/message', { text: 'Hello' });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/npm run channel:install/);
    expect(((await c.req('GET', '/api/status')).json as StatusDto).tvMessages.installed).toBe(false);
  });

  it('phone link: the Wi-Fi address as text and a QR code (signed in only)', async () => {
    const c = await ready();
    const res = await c.req('GET', '/api/phone');
    expect(res.status).toBe(200);
    const { url, qrSvg } = res.json as { url: string | null; qrSvg: string | null };
    if (url) {
      expect(url).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/$/);
      expect(qrSvg).toMatch(/^<svg[^>]+viewBox/);
    } else {
      expect(qrSvg).toBeNull(); // a machine with no network address
    }
    await c.req('POST', '/api/auth/logout', {});
    expect((await c.req('GET', '/api/phone')).status).toBe(401);
  });

  it('streams status over SSE', async () => {
    const c = await ready({}, { initial: { activeAppId: '12' } });
    await c.tick(0);
    await c.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (c.app.server.address() as AddressInfo).port;
    const first = await new Promise<string>((resolve, reject) => {
      const r = http.get({ host: '127.0.0.1', port, path: '/api/stream', headers: { cookie: c.cookie } }, (res) => {
        expect(res.headers['content-type']).toMatch(/text\/event-stream/);
        res.setEncoding('utf8');
        res.once('data', (chunk: string) => {
          resolve(chunk);
          r.destroy();
        });
      });
      r.on('error', reject);
    });
    expect(first).toMatch(/^event: status\ndata: \{/);
    expect(JSON.parse(first.split('data: ')[1]!).current.appId).toBe('12');
  });
});
