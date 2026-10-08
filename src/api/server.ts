import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import type { Logger } from 'pino';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { Guardian } from '../app.js';
import { TvTextsSchema } from '../config/schema.js';
import { channelVersion } from '../channel/package.js';
import { lanUrls } from '../ecp/discovery.js';
import { isEcpError } from '../ecp/types.js';
import { TvMessageError } from '../enforce/enforcer.js';
import { MESSAGE_KEYS } from '../enforce/message-catalog.js';
import { MAX_PARENT_MESSAGE } from '../enforce/tv-messages.js';
import { isLanAddress } from '../lib/net.js';
import { projectRoot } from '../lib/paths.js';
import type { Notifier } from '../notify/notifier.js';
import { describeOverride } from '../rules/engine.js';
import { SettingsValidationError, type Section } from '../settings/runtime.js';
import { localDayRange } from '../lib/time.js';
import { PIN_PATTERN, type AuthService } from './auth.js';
import type { ActionResultDto, AuthStateDto, EventDto, PhoneLinkDto, RulesDto, SettingsDto } from './contract.js';
import type { IconCache } from './icons.js';
import { buildApps, buildStatus, buildUsageDays } from './status.js';

export const SESSION_COOKIE = 'rg_session';

export interface ApiDeps {
  guardian: Guardian;
  auth: AuthService;
  icons: IconCache;
  notifier: Notifier;
  logger: Logger;
  /** Directory with the built dashboard (web/dist). Default: <project>/web/dist. */
  webRoot?: string | null;
  /** Login attempts per IP per minute. */
  loginRateLimit?: number;
}

const minutesBody = z
  .object({
    minutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .nullable()
      .optional(),
  })
  .strict();
const bonusBody = z
  .object({
    minutes: z
      .number()
      .int()
      .min(-600)
      .max(600)
      .refine((n) => n !== 0),
  })
  .strict();
const loginBody = z.object({ pin: z.string().max(64) }).strict();
const messageBody = z
  .object({
    text: z.string().trim().min(1, 'Write a message').max(MAX_PARENT_MESSAGE),
    returnToShow: z.boolean().default(false),
  })
  .strict();
const pinChangeBody = z.object({ current: z.string().max(64), next: z.string() }).strict();
const previewBody = z.object({ key: z.enum(MESSAGE_KEYS), texts: TvTextsSchema.default({}) }).strict();
const SETTINGS_SECTIONS = ['enforcement', 'notifications', 'device', 'monitor', 'tvMessages'] as const;

let packageVersion: string | null | undefined;
function packagedChannelVersion(): string | null {
  if (packageVersion === undefined) {
    try {
      packageVersion = channelVersion();
    } catch {
      packageVersion = null;
    }
  }
  return packageVersion;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: string,
  ) {
    super(message);
  }
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new HttpError(400, 'Invalid request', z.prettifyError(r.error));
  return r.data;
}

export async function buildApi(deps: ApiDeps): Promise<FastifyInstance> {
  const { guardian: g, auth, icons, notifier } = deps;
  const cfg = g.config;
  const changes = new EventEmitter<{ change: [] }>(); // actions → push a fresh status to SSE clients

  const app = Fastify({
    loggerInstance: deps.logger.child({ mod: 'http' }) as unknown as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 256 * 1024,
    trustProxy: false,
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  // ─── Guards ─────────────────────────────────────────────────────────────
  app.addHook('onRequest', async (req, reply) => {
    if (cfg.http.lanOnly && !isLanAddress(req.ip)) {
      return reply.code(403).send({ error: 'The dashboard is only available on the local network.' });
    }
    // Defence in depth against CSRF (the session cookie is also SameSite=Strict): browsers can't
    // send a cross-site application/json POST without a CORS preflight, which we never allow.
    // (DELETE is exempt: it has no body, and a cross-site DELETE always needs a preflight.)
    if (req.url.startsWith('/api/') && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
        return reply.code(415).send({ error: 'Content-Type must be application/json' });
      }
    }
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    return payload;
  });
  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, details: err.details });
    if (err instanceof SettingsValidationError)
      return reply.code(400).send({ error: `Invalid ${err.section} settings`, details: err.issues });
    if (err instanceof TvMessageError) return reply.code(409).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) deps.logger.error({ err }, 'API error');
    return reply.code(status).send({ error: status >= 500 ? 'Internal error' : (err as Error).message });
  });

  const requireAuth = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!auth.validate(req.cookies[SESSION_COOKIE])) {
      await reply.code(401).send({ error: 'Not signed in' });
    }
  };
  const authed = { preHandler: requireAuth };

  // ─── Public ─────────────────────────────────────────────────────────────
  app.get('/api/health', async () => ({ ok: true, version: g.version }));

  app.get('/api/auth/state', async (req): Promise<AuthStateDto> => ({
    pinSet: auth.isPinSet(),
    authenticated: auth.validate(req.cookies[SESSION_COOKIE]),
    lockedUntil: auth.lockedUntilMs(),
  }));

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: deps.loginRateLimit ?? 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!auth.isPinSet())
        throw new HttpError(409, 'No PIN has been set. On the PC, run: npm run set-pin -- <digits>');
      const { pin } = parseBody(loginBody, req.body);
      const res = await auth.login(pin, { ip: req.ip, userAgent: req.headers['user-agent'] });
      if (!res.ok) {
        if (res.lockedUntil) throw new HttpError(429, 'Too many wrong PINs. Try again later.', String(res.lockedUntil));
        throw new HttpError(401, 'Wrong PIN');
      }
      reply.setCookie(SESSION_COOKIE, res.token!, {
        path: '/',
        httpOnly: true,
        sameSite: 'strict',
        secure: false, // plain HTTP on the LAN
        expires: new Date(res.expiresAt!),
      });
      g.repos.events.add({
        at: g.clock.now(),
        type: 'auth',
        severity: 'info',
        message: `Dashboard sign-in from ${req.ip}`,
      });
      return { ok: true };
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    auth.revoke(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // ─── Status & live stream ───────────────────────────────────────────────
  app.get('/api/status', authed, async () => buildStatus(g));

  app.get('/api/stream', authed, (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    let lastSent = 0;
    let pending: NodeJS.Timeout | null = null;
    const pushStatus = (): void => {
      const wait = 1000 - (Date.now() - lastSent);
      if (wait <= 0) {
        lastSent = Date.now();
        send('status', buildStatus(g));
      } else if (!pending) {
        pending = setTimeout(() => {
          pending = null;
          lastSent = Date.now();
          send('status', buildStatus(g));
        }, wait);
      }
    };
    const onEnforcement = (e: { at: number; message: string }): void => {
      send('enforcement', { at: e.at, message: e.message });
      pushStatus();
    };
    send('status', buildStatus(g));
    lastSent = Date.now();
    g.bus.on('observation', pushStatus);
    g.bus.on('health', pushStatus);
    g.bus.on('enforcement', onEnforcement);
    changes.on('change', pushStatus);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      if (pending) clearTimeout(pending);
      g.bus.off('observation', pushStatus);
      g.bus.off('health', pushStatus);
      g.bus.off('enforcement', onEnforcement);
      changes.off('change', pushStatus);
    });
  });

  // ─── Apps & icons ───────────────────────────────────────────────────────
  app.get('/api/apps', authed, async () => buildApps(g));

  app.get<{ Params: { id: string } }>('/api/apps/:id/icon', authed, async (req, reply) => {
    const icon = await icons.get(req.params.id);
    reply.header('Content-Type', icon.contentType);
    reply.header('Cache-Control', icon.placeholder ? 'private, max-age=60' : 'private, max-age=86400');
    return reply.send(icon.data);
  });

  // ─── Rules ──────────────────────────────────────────────────────────────
  const rulesDto = (): RulesDto => ({ rules: g.runtime.inputFor('rules'), source: g.runtime.sources().rules });
  app.get('/api/rules', authed, async () => rulesDto());
  app.put('/api/rules', authed, async (req) => {
    const body = parseBody(z.object({ rules: z.unknown() }).strict(), req.body);
    g.runtime.update('rules', body.rules);
    g.repos.events.add({
      at: g.clock.now(),
      type: 'config',
      severity: 'info',
      message: 'Rules updated from the dashboard',
    });
    changes.emit('change');
    return rulesDto();
  });
  app.delete('/api/rules', authed, async () => {
    g.runtime.reset('rules');
    g.repos.events.add({ at: g.clock.now(), type: 'config', severity: 'info', message: 'Rules reset to config.json' });
    changes.emit('change');
    return rulesDto();
  });

  // ─── Usage & events ─────────────────────────────────────────────────────
  app.get<{ Querystring: { days?: string } }>('/api/usage', authed, async (req) => {
    const days = Math.min(31, Math.max(1, Number(req.query.days ?? 7) || 7));
    return buildUsageDays(g, days);
  });

  app.get<{ Querystring: { limit?: string; type?: string } }>(
    '/api/events',
    authed,
    async (req): Promise<EventDto[]> => {
      const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100) || 100));
      const type = req.query.type && /^[a-z_]+$/.test(req.query.type) ? req.query.type : undefined;
      return g.repos.events
        .recent({ limit, ...(type ? { type } : {}) })
        .map(({ id, at, type: t, severity, message }) => ({ id, at, type: t, severity, message }));
    },
  );

  // ─── Quick actions ──────────────────────────────────────────────────────
  const act = (message: string, type = 'override', severity: 'info' | 'warn' = 'info'): ActionResultDto => {
    g.repos.events.add({ at: g.clock.now(), type, severity, message });
    changes.emit('change');
    return { ok: true, message };
  };

  app.post('/api/actions/lock', authed, async (req): Promise<ActionResultDto> => {
    const { minutes } = parseBody(minutesBody, req.body);
    const now = g.clock.now();
    const o = { kind: 'lock' as const, until: minutes ? now + minutes * 60_000 : null, setAt: now, note: 'dashboard' };
    g.repos.overrides.set(o);
    // A parent's explicit lock acts now, even in dry-run (after a short countdown on the TV, if
    // the Parental Control channel is installed).
    const result = await g.enforcer.lockNow();
    return act(`${describeOverride(o, cfg.timezone)} — ${result}`, 'override', 'warn');
  });

  app.post('/api/actions/pause', authed, async (req): Promise<ActionResultDto> => {
    const { minutes } = parseBody(minutesBody, req.body);
    const now = g.clock.now();
    const o = { kind: 'pause' as const, until: minutes ? now + minutes * 60_000 : null, setAt: now, note: 'dashboard' };
    g.repos.overrides.set(o);
    return act(describeOverride(o, cfg.timezone));
  });

  app.post('/api/actions/resume', authed, async (): Promise<ActionResultDto> => {
    const before = g.repos.overrides.get();
    g.repos.overrides.clear();
    g.poller.pollNow();
    return act(before?.kind === 'lock' ? 'TV unlocked' : before ? 'Enforcement resumed' : 'Nothing to resume');
  });

  app.post('/api/actions/bonus', authed, async (req): Promise<ActionResultDto> => {
    const { minutes } = parseBody(bonusBody, req.body);
    const now = g.clock.now();
    const total = g.repos.overrides.addBonus(localDayRange(now, cfg.timezone).day, minutes, now);
    return act(`Bonus ${minutes > 0 ? '+' : ''}${minutes} min (today: ${total} min)`);
  });

  app.post('/api/actions/home', authed, async (): Promise<ActionResultDto> => {
    try {
      await g.poller.sendKey('Home');
    } catch (err) {
      if (isEcpError(err, 'restricted')) g.poller.reportControlRestricted();
      throw new HttpError(502, `Could not send Home: ${(err as Error).message}`);
    }
    g.poller.pollNow();
    return act('Sent Home from the dashboard', 'enforcement');
  });

  app.post('/api/actions/message', authed, async (req): Promise<ActionResultDto> => {
    const { text, returnToShow } = parseBody(messageBody, req.body);
    const message = await g.enforcer.sendMessage(text, { returnToShow });
    changes.emit('change');
    return { ok: true, message };
  });

  app.post('/api/tv-messages/test', authed, async (): Promise<ActionResultDto> => {
    const message = await g.enforcer.sendTestMessage();
    return { ok: true, message };
  });

  app.post('/api/tv-messages/preview', authed, async (req): Promise<ActionResultDto> => {
    const { key, texts } = parseBody(previewBody, req.body);
    const message = await g.enforcer.sendPreview(key, texts);
    return { ok: true, message };
  });

  app.post('/api/tv-messages/refresh', authed, async (): Promise<ActionResultDto> => {
    g.poller.refreshApps();
    return { ok: true, message: 'Checking the TV’s channels' };
  });

  app.get('/api/phone', authed, async (): Promise<PhoneLinkDto> => {
    const url = lanUrls(cfg.http.port)[0] ?? null;
    if (!url) return { url: null, qrSvg: null };
    const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#10152a', light: '#ffffff' } });
    return { url, qrSvg };
  });

  app.post('/api/actions/rediscover', authed, async (): Promise<ActionResultDto> => {
    g.poller.rediscover();
    return { ok: true, message: 'Looking for the TV' };
  });

  // ─── Settings ───────────────────────────────────────────────────────────
  const settingsDto = (): SettingsDto => {
    const r = g.runtime;
    const pinned = g.repos.devices.pinned();
    return {
      version: g.version,
      timezone: cfg.timezone,
      sources: r.sources(),
      device: {
        serial: r.device.serial ?? null,
        host: r.device.host ?? null,
        port: cfg.device.port,
        pinned: pinned
          ? { serial: pinned.serial, name: pinned.name, model: pinned.model, host: pinned.host, port: pinned.port }
          : null,
      },
      monitor: { pollIntervalSec: r.pollIntervalSec },
      enforcement: r.enforcement,
      notifications: { ...r.notifications, tokenConfigured: Boolean(process.env.NTFY_TOKEN) },
      http: { port: cfg.http.port, lanOnly: cfg.http.lanOnly },
      tvMessages: {
        ...r.tvMessages,
        installed: g.enforcer.tv.installed(),
        installedVersion:
          g.repos.apps.list({ installedOnly: true }).find((a) => a.appId === r.tvMessages.appId)?.version ?? null,
        packageVersion: packagedChannelVersion(),
      },
    };
  };
  app.get('/api/settings', authed, async () => settingsDto());
  app.put<{ Params: { section: string } }>('/api/settings/:section', authed, async (req) => {
    const section = req.params.section as (typeof SETTINGS_SECTIONS)[number];
    if (!SETTINGS_SECTIONS.includes(section)) throw new HttpError(404, 'Unknown settings section');
    g.runtime.update(section as Section, req.body);
    g.repos.events.add({
      at: g.clock.now(),
      type: 'config',
      severity: 'info',
      message: `Settings updated: ${section}`,
    });
    changes.emit('change');
    return settingsDto();
  });
  app.delete<{ Params: { section: string } }>('/api/settings/:section', authed, async (req) => {
    const section = req.params.section as (typeof SETTINGS_SECTIONS)[number];
    if (!SETTINGS_SECTIONS.includes(section)) throw new HttpError(404, 'Unknown settings section');
    g.runtime.reset(section as Section);
    changes.emit('change');
    return settingsDto();
  });

  app.post('/api/settings/pin', authed, async (req, reply) => {
    const { current, next } = parseBody(pinChangeBody, req.body);
    if (!(await auth.verifyPin(current))) throw new HttpError(403, 'Current PIN is wrong');
    if (!PIN_PATTERN.test(next)) throw new HttpError(400, 'The new PIN must be 4–12 digits');
    await auth.setPin(next); // signs everyone out…
    const s = auth.createSession({ ip: req.ip, userAgent: req.headers['user-agent'] }); // …except this device
    reply.setCookie(SESSION_COOKIE, s.token, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: false,
      expires: new Date(s.expiresAt),
    });
    g.repos.events.add({ at: g.clock.now(), type: 'auth', severity: 'warn', message: 'Dashboard PIN changed' });
    return { ok: true };
  });

  app.post('/api/notifications/test', authed, async (): Promise<ActionResultDto> => {
    const r = await notifier.test();
    if (!r.ok) throw new HttpError(502, `Notification failed: ${r.error ?? 'unknown error'}`);
    return { ok: true, message: 'Test notification sent' };
  });

  // ─── Dashboard (static SPA) ─────────────────────────────────────────────
  const webRoot = deps.webRoot === undefined ? path.join(projectRoot(), 'web', 'dist') : deps.webRoot;
  const hasWeb = webRoot !== null && existsSync(path.join(webRoot, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: webRoot,
      setHeaders: (res, filePath) => {
        res.header(
          'Cache-Control',
          filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
  }
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
    if (hasWeb && req.method === 'GET') return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    return reply
      .code(503)
      .type('text/html')
      .send(
        '<!doctype html><meta name="viewport" content="width=device-width"><title>Roku TV Parental Control</title><body style="font-family:system-ui;padding:2rem"><h1>Dashboard not built</h1><p>On the PC, run <code>npm run build:web</code>, then reload this page.</p></body>',
      );
  });

  return app;
}
