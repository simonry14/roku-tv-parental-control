import { existsSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { AuthService } from './api/auth.js';
import { IconCache } from './api/icons.js';
import { buildApi } from './api/server.js';
import { loadConfig } from './config/load.js';
import type { Config } from './config/schema.js';
import { openDatabase, type Db } from './db/database.js';
import { createRepos, type Repos } from './db/repo.js';
import { EcpClient } from './ecp/client.js';
import { lanUrls, scanSubnet, ssdpDiscover } from './ecp/discovery.js';
import { DeviceLocator } from './ecp/locator.js';
import { SystemReachability, type Reachability } from './ecp/reachability.js';
import { Enforcer } from './enforce/enforcer.js';
import { GuardianBus } from './lib/bus.js';
import { formatDuration, systemClock, type Clock } from './lib/time.js';
import { Poller, type EcpClientLike } from './monitor/poller.js';
import { SessionTracker } from './monitor/sessions.js';
import { Notifier } from './notify/notifier.js';
import { BackupService } from './ops/backup.js';
import { NtfyClient, type FetchLike } from './notify/ntfy.js';
import { RuntimeConfig } from './settings/runtime.js';
import { UsageService } from './usage/usage.js';

export const VERSION = '1.0.0';

export interface Guardian {
  version: string;
  config: Config;
  /** Live, dashboard-editable settings (rules, enforcement, notifications, device, poll interval, TV messages). */
  runtime: RuntimeConfig;
  clock: Clock;
  db: Db;
  repos: Repos;
  bus: GuardianBus;
  locator: DeviceLocator;
  tracker: SessionTracker;
  poller: Poller;
  usage: UsageService;
  enforcer: Enforcer;
  notifier: Notifier;
  auth: AuthService;
  icons: IconCache;
  backups: BackupService;
  logger: Logger;
  /** The dashboard/API server once started (null if disabled or not started). */
  http: FastifyInstance | null;
  /** Re-read config.json and apply its live sections. Returns false if the file is invalid. */
  reloadConfig(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Injection points for tests (mock ECP host, fake clock, fake reachability, in-memory DB). */
export interface GuardianOverrides {
  clock?: Clock;
  db?: Db;
  reachability?: Reachability;
  createClient?: (target: { host: string; port: number }) => EcpClientLike;
  ssdp?: (opts: { stopOnSerial?: string }) => ReturnType<typeof ssdpDiscover>;
  scan?: (opts: { stopOnSerial?: string }) => ReturnType<typeof scanSubnet>;
  /** Watch config.json for changes (default true; ignored if the file doesn't exist). */
  watchConfig?: boolean;
  /** Start the HTTP server in start() (default: config.http.enabled). */
  http?: boolean;
  /** Run nightly backups (default: config.backup.enabled). */
  backups?: boolean;
  ntfyFetch?: FetchLike;
  webRoot?: string | null;
}

/** Composition root: builds every component from config. Does no network I/O until start(). */
export function createGuardian(config: Config, logger: Logger, overrides: GuardianOverrides = {}): Guardian {
  const clock = overrides.clock ?? systemClock;
  const db = overrides.db ?? openDatabase(config.database.path, { logger });
  const repos = createRepos(db);
  const bus = new GuardianBus();
  const runtime = new RuntimeConfig(config, repos.settings, logger.child({ mod: 'settings' }));
  const timeoutMs = config.monitor.requestTimeoutMs;
  const createClient = overrides.createClient ?? ((t) => new EcpClient({ host: t.host, port: t.port, timeoutMs }));
  const { discovery } = config;

  const locator = new DeviceLocator(
    {
      serial: runtime.device.serial,
      host: runtime.device.host,
      port: config.device.port,
      subnetScan: discovery.subnetScan,
      scanMinIntervalMs: discovery.scanMinIntervalSec * 1000,
    },
    {
      devices: repos.devices,
      events: repos.events,
      clock,
      logger: logger.child({ mod: 'locator' }),
      probe: (host, port) => createClient({ host, port }).deviceInfo(),
      ssdp:
        overrides.ssdp ??
        ((o) =>
          ssdpDiscover({
            timeoutMs: discovery.ssdpTimeoutMs,
            ...(discovery.interfaces ? { interfaces: discovery.interfaces } : {}),
            ...(o.stopOnSerial ? { stopOnSerial: o.stopOnSerial } : {}),
            logger,
          })),
      scan:
        overrides.scan ??
        ((o) =>
          scanSubnet({
            port: config.device.port,
            timeoutMs: discovery.scanTimeoutMs,
            concurrency: discovery.scanConcurrency,
            ...(discovery.interfaces ? { interfaces: discovery.interfaces } : {}),
            ...(o.stopOnSerial ? { stopOnSerial: o.stopOnSerial } : {}),
            logger,
          })),
    },
  );

  // A slower poll interval needs a wider gap tolerance, or every poll would split the session.
  const maxGapMs = (): number => Math.max(config.monitor.maxGapSec, runtime.pollIntervalSec * 3) * 1000;
  const tracker = new SessionTracker(repos, { maxGapMs: maxGapMs() });
  const usage = new UsageService(repos.sessions, config.timezone, config.usage.excludeAppIds);
  const poller = new Poller({
    config,
    repos,
    locator,
    tracker,
    reachability: overrides.reachability ?? new SystemReachability(),
    createClient,
    bus,
    clock,
    logger: logger.child({ mod: 'poller' }),
    getPollIntervalSec: () => runtime.pollIntervalSec,
  });

  const enforcer = new Enforcer({
    bus,
    repos,
    usage,
    control: poller,
    getRules: () => runtime.rules,
    getSettings: () => runtime.enforcement,
    getTvMessages: () => runtime.tvMessages,
    zone: config.timezone,
    clock,
    logger: logger.child({ mod: 'enforcer' }),
  });
  enforcer.start();

  const ntfy = new NtfyClient(
    () => runtime.notifications.ntfy,
    process.env.NTFY_TOKEN || undefined,
    logger.child({ mod: 'ntfy' }),
    overrides.ntfyFetch,
  );
  const notifier = new Notifier({
    bus,
    ntfy,
    getConfig: () => runtime.notifications,
    events: repos.events,
    clock,
    zone: config.timezone,
    logger: logger.child({ mod: 'notify' }),
  });
  notifier.start();

  const auth = new AuthService(db, repos.settings, { sessionDays: config.http.sessionDays }, clock, (until) => {
    repos.events.add({
      at: clock.now(),
      type: 'auth',
      severity: 'warn',
      message: 'Dashboard logins locked after repeated wrong PINs',
    });
    void notifier.loginLockout(until);
  });
  const icons = new IconCache(
    db,
    (appId) => poller.fetchIcon(appId),
    (appId) => repos.apps.list().find((a) => a.appId === appId)?.name ?? null,
    clock,
    logger.child({ mod: 'icons' }),
  );

  const backups = new BackupService({
    db,
    config: config.backup,
    zone: config.timezone,
    clock,
    logger: logger.child({ mod: 'backup' }),
    events: repos.events,
  });

  runtime.on('change', (sections) => {
    for (const s of sections) {
      repos.events.add({ at: clock.now(), type: 'config', severity: 'info', message: `Settings applied: ${s}` });
    }
    if (sections.includes('device')) {
      locator.setDevice(runtime.device);
      poller.rediscover();
    }
    if (sections.includes('monitor')) {
      tracker.setMaxGapMs(maxGapMs());
      poller.pollNow();
    }
    if (sections.includes('enforcement'))
      logger.info({ mode: runtime.enforcement.mode }, 'Enforcement settings applied');
  });

  const reloadConfig = (): boolean => {
    try {
      const changed = runtime.reloadFile(loadConfig({ configPath: config.configPath }));
      if (changed.length) logger.info({ sections: changed }, 'Reloaded config.json');
      return true;
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'config.json is invalid — keeping the previous settings');
      return false;
    }
  };

  let watcher: FSWatcher | null = null;
  let reloadTimer: NodeJS.Timeout | null = null;
  const startWatching = (): void => {
    if (overrides.watchConfig === false || !existsSync(config.configPath)) return;
    // Watch the directory, not the file: editors often save by replacing the file.
    const file = path.basename(config.configPath);
    watcher = watch(path.dirname(config.configPath), (_event, name) => {
      if (name !== file) return;
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(reloadConfig, 500);
    });
    watcher.on('error', (err) => logger.warn({ err }, 'Config watcher error'));
  };

  let started = false;

  const guardian: Guardian = {
    version: VERSION,
    config,
    runtime,
    clock,
    db,
    repos,
    bus,
    locator,
    tracker,
    poller,
    usage,
    enforcer,
    notifier,
    auth,
    icons,
    backups,
    logger,
    http: null,
    reloadConfig,
    async start() {
      if (started) return;
      started = true;
      const now = clock.now();
      const recovered = tracker.recover(now);
      if (recovered) {
        logger.info(
          { app: recovered.appName, duration: formatDuration(recovered.durationMs) },
          'Closed session left open by previous run (at its last confirmed poll)',
        );
      }
      repos.runtime.set('service', { version: VERSION, pid: process.pid, startedAt: now }, now);
      repos.events.add({
        at: now,
        type: 'service',
        severity: 'info',
        message: `Service started (v${VERSION})`,
        data: { pid: process.pid },
      });
      logger.info(
        {
          version: VERSION,
          db: config.database.path,
          tz: config.timezone,
          pollIntervalSec: runtime.pollIntervalSec,
          enforcement: runtime.enforcement.mode,
        },
        'Roku TV Parental Control starting',
      );
      if (runtime.enforcement.mode !== 'enforce') {
        logger.warn(
          `Enforcement is "${runtime.enforcement.mode}": the TV will NOT be controlled. Switch it to "enforce" in the dashboard (Settings) or in config.json when ready.`,
        );
      }
      startWatching();
      poller.start();
      if (overrides.backups ?? true) backups.start();

      if (overrides.http ?? config.http.enabled) {
        try {
          const app = await buildApi({
            guardian,
            auth,
            icons,
            notifier,
            logger,
            ...(overrides.webRoot !== undefined ? { webRoot: overrides.webRoot } : {}),
          });
          await app.listen({ host: config.http.host, port: config.http.port });
          guardian.http = app;
          const urls =
            config.http.host === '0.0.0.0'
              ? lanUrls(config.http.port)
              : [`http://${config.http.host}:${config.http.port}/`];
          logger.info({ urls }, `Dashboard: ${urls[0] ?? `http://localhost:${config.http.port}/`}`);
          if (!auth.isPinSet())
            logger.warn('No dashboard PIN yet. Set one on this PC with: npm run set-pin -- <4-12 digits>');
        } catch (err) {
          // Monitoring and enforcement keep running even if the dashboard can't start.
          logger.error({ err: (err as Error).message, port: config.http.port }, 'Dashboard failed to start');
        }
      }
    },
    async stop() {
      if (!started) return;
      started = false;
      watcher?.close();
      if (reloadTimer) clearTimeout(reloadTimer);
      await guardian.http?.close();
      guardian.http = null;
      await poller.stop();
      await enforcer.stop();
      await backups.stop();
      notifier.stop();
      const now = clock.now();
      // Leave any open session open: its counted time already ends at last_seen_at, and a quick
      // restart can continue it. recover() closes it on next start if it has gone stale.
      repos.events.add({ at: now, type: 'service', severity: 'info', message: 'Service stopped' });
      const live = repos.runtime.get<Record<string, unknown>>('live');
      if (live) repos.runtime.set('live', { ...live.value, stoppedAt: now }, now);
      if (!overrides.db) db.close();
      logger.info('Roku TV Parental Control stopped');
    },
  };
  return guardian;
}
