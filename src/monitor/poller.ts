import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import type { Repos } from '../db/repo.js';
import type { EcpClient } from '../ecp/client.js';
import type { DeviceLocator, DeviceTarget } from '../ecp/locator.js';
import type { Reachability } from '../ecp/reachability.js';
import { isEcpError, type DeviceInfo, type EcpKey } from '../ecp/types.js';
import type { GuardianBus } from '../lib/bus.js';
import { formatDuration, type Clock } from '../lib/time.js';
import { classifyActiveApp, type Observation } from './observation.js';
import type { SessionTracker } from './sessions.js';
import { healthMessage, healthSeverity, type Health, type LiveStatus, type Restriction } from './status.js';

export type EcpClientLike = Pick<
  EcpClient,
  'host' | 'port' | 'deviceInfo' | 'activeApp' | 'apps' | 'icon' | 'keypress' | 'launch' | 'input'
>;

export interface PollerDeps {
  config: Config;
  repos: Repos;
  locator: DeviceLocator;
  tracker: SessionTracker;
  reachability: Reachability;
  createClient(target: { host: string; port: number }): EcpClientLike;
  bus: GuardianBus;
  clock: Clock;
  logger: Logger;
  /** Live poll interval (dashboard-editable). Defaults to config.monitor.pollIntervalSec. */
  getPollIntervalSec?: () => number;
}

/** Presence checks spawn ping/arp — don't do that on every 5-second poll. */
const PRESENCE_CACHE_MS = 30_000;
/** While Limited mode is detected, re-check more often so the "fixed" state shows up quickly. */
const LIMITED_REPROBE_MS = 15_000;
/** Minimum spacing of rediscovery attempts triggered by "wrong device at the pinned address". */
const SUSPICION_RELOCATE_MS = 30_000;

/**
 * The monitoring loop. Each tick: device-info (+ active-app when the screen is on) → observation
 * → session accounting → health/status → bus events. Ticks never overlap; the next one is
 * scheduled after the previous finishes, with exponential backoff while the TV is unreachable.
 */
export class Poller {
  private target: DeviceTarget | null = null;
  private client: EcpClientLike | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight: Promise<void> | null = null;

  private lastLocateAt = Number.NEGATIVE_INFINITY;
  private lastAppsAt = Number.NEGATIVE_INFINITY;
  private lastProbeAt = Number.NEGATIVE_INFINITY;
  private probeAppId: string | null = null;
  private limited = false;
  private presenceCache: { host: string; at: number; alive: boolean; mac: string | null } | null = null;

  private readonly status: LiveStatus;

  constructor(private readonly deps: PollerDeps) {
    const now = deps.clock.now();
    this.status = {
      health: 'starting',
      healthSince: now,
      restriction: null,
      message: healthMessage('starting', null),
      device: null,
      powerMode: null,
      activity: null,
      lastPollAt: null,
      lastSuccessAt: null,
      consecutiveFailures: 0,
      pollIntervalMs: this.baseIntervalMs,
      lastError: null,
    };
  }

  private get baseIntervalMs(): number {
    return (this.deps.getPollIntervalSec?.() ?? this.deps.config.monitor.pollIntervalSec) * 1000;
  }

  getStatus(): LiveStatus {
    return structuredClone(this.status);
  }

  getTarget(): DeviceTarget | null {
    return this.target ? { ...this.target } : null;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  /** Force an immediate poll (e.g. after an enforcement action). */
  pollNow(): void {
    if (!this.running || this.inFlight) return;
    this.schedule(0);
  }

  /** Forget the current TV address and rediscover on the next poll (device settings changed). */
  rediscover(): void {
    this.dropTarget();
    this.pollNow();
  }

  /** Fetch a channel icon from the TV (dashboard icon cache). Throws EcpError on failure. */
  async fetchIcon(appId: string): Promise<{ contentType: string; data: Buffer }> {
    if (!this.client) throw new Error('No TV located yet');
    return this.client.icon(appId);
  }

  /** Send a remote key to the current TV (used by the enforcer). Throws EcpError on failure. */
  async sendKey(key: EcpKey): Promise<void> {
    if (!this.client) throw new Error('No TV located yet');
    await this.client.keypress(key);
  }

  /** Open a channel on the TV, with parameters for it. Throws EcpError on failure. */
  async launch(appId: string, params?: Record<string, string>): Promise<void> {
    if (!this.client) throw new Error('No TV located yet');
    await this.client.launch(appId, params);
  }

  /** Send parameters to the channel on screen (roInputEvent). Throws EcpError on failure. */
  async input(params: Record<string, string>): Promise<void> {
    if (!this.client) throw new Error('No TV located yet');
    await this.client.input(params);
  }

  /** What is in the foreground right now (null = Home screen). Throws EcpError on failure. */
  async foregroundAppId(): Promise<string | null> {
    if (!this.client) throw new Error('No TV located yet');
    return (await this.client.activeApp()).app?.id ?? null;
  }

  /** Re-read the TV's installed channels on the next poll (e.g. right after sideloading). */
  refreshApps(): void {
    this.lastAppsAt = Number.NEGATIVE_INFINITY;
    this.pollNow();
  }

  /**
   * Called by the enforcer when a keypress is answered with 401/403, so Limited mode
   * is flagged immediately rather than at the next canary probe.
   */
  reportControlRestricted(): void {
    if (!this.limited) this.deps.logger.warn('Control command refused (HTTP 403) — ECP is in Limited mode');
    this.limited = true;
    this.lastProbeAt = this.deps.clock.now();
    if (this.status.health === 'online' || this.status.health === 'tv_off') {
      this.setHealth('restricted', 'limited', this.deps.clock.now());
    }
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inFlight = this.tick()
        .catch((err: unknown) => this.deps.logger.error({ err }, 'Poll tick crashed'))
        .finally(() => {
          this.inFlight = null;
          this.schedule(this.status.pollIntervalMs);
        });
    }, delayMs);
  }

  /** Delay before the next tick: the poll interval, backed off exponentially while unreachable. */
  private computeNextDelayMs(): number {
    const { monitor } = this.deps.config;
    const base = this.baseIntervalMs;
    let delay = base;
    if (this.status.health === 'offline' || this.status.health === 'searching') {
      const over = Math.max(0, this.status.consecutiveFailures - monitor.offlineAfterFailures);
      delay = Math.min(base * 2 ** over, Math.max(base, monitor.offlineBackoffMaxSec * 1000));
    }
    return delay;
  }

  /** One poll. Public for tests and the CLI; normally driven by start(). */
  async tick(): Promise<void> {
    const { clock, repos, tracker, logger, bus, config } = this.deps;
    const now = clock.now();
    this.status.lastPollAt = now;

    if (!this.target || !this.client) {
      await this.locate(now);
    }

    let obs: Observation;
    if (!this.target || !this.client) {
      obs = { status: 'unknown', reason: 'unreachable' };
      this.status.consecutiveFailures++;
      this.setHealth('searching', null, now);
    } else {
      obs = await this.observe(now, this.target, this.client);
    }

    const change = tracker.observe(obs, now);
    for (const s of change.closed) {
      logger.info(
        { app: s.appName, kind: s.kind, duration: formatDuration(s.durationMs), reason: s.endReason },
        `Session ended: ${s.appName ?? s.kind}`,
      );
    }
    if (change.opened) {
      logger.info(
        { app: change.opened.appName, kind: change.opened.kind },
        `Session started: ${change.opened.appName ?? change.opened.kind}`,
      );
      if (change.opened.kind === 'app' && change.opened.appId && obs.status === 'watching') {
        repos.apps.noteSeen({ id: change.opened.appId, name: obs.appName, type: obs.appType }, now);
      }
    }
    if (change.closed.length || change.opened) bus.emit('session', { at: now, ...change });

    const open = tracker.current();
    this.status.activity =
      obs.status === 'watching' && open
        ? { kind: open.kind, appId: open.appId, appName: open.appName ?? obs.appName, since: open.startedAt }
        : null;

    this.status.pollIntervalMs = this.computeNextDelayMs();
    repos.runtime.set('live', { ...this.status, pid: process.pid, maxGapSec: config.monitor.maxGapSec }, now);
    bus.emit('observation', { at: now, observation: obs, status: this.getStatus() });
  }

  // ─── observation ──────────────────────────────────────────────────────────

  private async observe(now: number, target: DeviceTarget, client: EcpClientLike): Promise<Observation> {
    let info: DeviceInfo;
    let obs: Observation;
    try {
      info = await client.deviceInfo();
      if (info.serialNumber && info.serialNumber !== target.serial) {
        // Another Roku now answers at this address (DHCP shuffle). Re-locate on the next tick.
        this.deps.logger.warn(
          { host: target.host, found: info.serialNumber, expected: target.serial },
          'Different TV at pinned address',
        );
        this.dropTarget();
        return this.onFailure(now, new Error('different device at address'), target);
      }
      // Record what device-info told us even if active-app is refused next.
      this.status.powerMode = info.powerMode;
      this.status.device = {
        serial: target.serial,
        name: info.name,
        model: info.modelName,
        host: target.host,
        port: target.port,
      };
      if (info.powerMode === 'PowerOn') {
        obs = classifyActiveApp(await client.activeApp(), target.serial);
      } else {
        obs = { status: 'off', deviceSerial: target.serial, powerMode: info.powerMode };
      }
    } catch (err) {
      return this.onFailure(now, err, target);
    }

    // Success
    this.status.consecutiveFailures = 0;
    this.status.lastSuccessAt = now;
    this.status.lastError = null;
    this.presenceCache = null;
    this.deps.repos.devices.touch(target.serial, now);

    await this.maybeRefreshApps(now, client);
    await this.maybeProbeRestriction(now, client);

    if (this.limited) this.setHealth('restricted', 'limited', now);
    else this.setHealth(info.powerMode === 'PowerOn' ? 'online' : 'tv_off', null, now);
    return obs;
  }

  private async onFailure(now: number, err: unknown, target: DeviceTarget): Promise<Observation> {
    const { config, logger } = this.deps;
    this.status.consecutiveFailures++;
    this.status.lastError = err instanceof Error ? err.message : String(err);
    const failures = this.status.consecutiveFailures;
    logger.debug({ err: this.status.lastError, failures }, 'Poll failed');

    let reason: 'unreachable' | 'restricted' = 'unreachable';
    const { rediscoverAfterFailures, rediscoverMinIntervalSec } = config.discovery;
    const pastThreshold = failures >= config.monitor.offlineAfterFailures;

    if (isEcpError(err, 'restricted')) {
      // The TV itself answered 401/403 to a query: unambiguous.
      reason = 'restricted';
      this.setHealth('restricted', 'blocked', now);
    } else if (isEcpError(err, 'refused')) {
      // Port 8060 closed. A refusal (TCP RST) proves *a* host is up at this address, so the only
      // question is whose: ECP switched off on our TV (tamper), or DHCP gave the address to
      // another device. The ARP MAC answers that when available (ping only warms the ARP cache).
      const presence = await this.presence(target.host, now);
      const macMatches = target.macs.length > 0 && presence.mac !== null ? target.macs.includes(presence.mac) : null;
      if (macMatches === false) {
        logger.warn(
          { host: target.host, mac: presence.mac },
          'Pinned address now belongs to another device — rediscovering',
        );
        if (now - this.lastLocateAt >= SUSPICION_RELOCATE_MS && (await this.relocate(now)))
          return { status: 'unknown', reason };
        if (pastThreshold) this.setHealth('offline', null, now);
      } else {
        reason = 'restricted';
        const alreadyFlagged = this.status.health === 'restricted' && this.status.restriction === 'disabled';
        if (pastThreshold && !alreadyFlagged) {
          // About to raise the tamper alarm. Unless ARP proves this is our TV, first make sure it
          // hasn't simply moved to a new DHCP address (and another device took the old one).
          if (macMatches !== true && (await this.relocate(now))) return { status: 'unknown', reason: 'unreachable' };
          this.setHealth('restricted', 'disabled', now);
        }
      }
    } else if (pastThreshold) {
      this.setHealth('offline', null, now);
    }

    // The TV may have moved (DHCP) or be off: rediscover by serial, throttled.
    if (failures >= rediscoverAfterFailures && now - this.lastLocateAt >= rediscoverMinIntervalSec * 1000) {
      await this.locate(now);
    }
    return { status: 'unknown', reason };
  }

  private async presence(host: string, now: number): Promise<{ alive: boolean; mac: string | null }> {
    const c = this.presenceCache;
    if (c && c.host === host && now - c.at < PRESENCE_CACHE_MS) return c;
    const res = await this.deps.reachability.presence(host);
    this.presenceCache = { host, at: now, ...res };
    return res;
  }

  // ─── discovery ────────────────────────────────────────────────────────────

  /** Rediscover now; true if the TV was found somewhere other than the current target. */
  private async relocate(now: number): Promise<boolean> {
    const before = this.target;
    await this.locate(now);
    const after = this.target;
    return Boolean(
      after && before && (after.host !== before.host || after.port !== before.port || after.serial !== before.serial),
    );
  }

  private async locate(now: number): Promise<void> {
    const { locator, logger, bus, createClient } = this.deps;
    this.lastLocateAt = now;
    const res = await locator.locate();
    if (res.ok) {
      const moved =
        !this.target ||
        this.target.host !== res.target.host ||
        this.target.port !== res.target.port ||
        this.target.serial !== res.target.serial;
      this.target = res.target;
      const t = res.target;
      this.status.device = { serial: t.serial, name: t.name, model: t.model, host: t.host, port: t.port };
      if (res.restricted) logger.warn({ serial: t.serial, host: t.host }, 'TV located but it refuses ECP queries');
      if (moved || !this.client) {
        this.client = createClient(res.target);
        this.lastAppsAt = Number.NEGATIVE_INFINITY;
        this.lastProbeAt = Number.NEGATIVE_INFINITY;
        this.limited = false;
        logger.info(
          { serial: res.target.serial, host: res.target.host, port: res.target.port, via: res.via },
          `Using TV "${res.target.name}"`,
        );
        bus.emit('device', {
          at: now,
          via: res.via,
          device: {
            serial: res.target.serial,
            name: res.target.name,
            model: res.target.model,
            host: res.target.host,
            port: res.target.port,
          },
        });
      }
      return;
    }
    logger.warn({ reason: res.reason, candidates: res.candidates.length }, 'TV not located');
    this.status.lastError = res.reason;
    // Keep polling the last-known address so we notice the TV the moment it comes back.
    if (!this.target) {
      const fallback = locator.fallbackTarget();
      if (fallback) {
        this.target = fallback;
        this.client = createClient(fallback);
        logger.info(
          { host: fallback.host, serial: fallback.serial },
          'Polling last-known address until the TV answers',
        );
      }
    }
  }

  private dropTarget(): void {
    this.target = null;
    this.client = null;
    this.lastLocateAt = Number.NEGATIVE_INFINITY;
  }

  // ─── periodic extras ──────────────────────────────────────────────────────

  private async maybeRefreshApps(now: number, client: EcpClientLike): Promise<void> {
    if (now - this.lastAppsAt < this.deps.config.monitor.appsRefreshIntervalSec * 1000) return;
    this.lastAppsAt = now;
    try {
      const apps = await client.apps();
      this.deps.repos.apps.syncInstalled(apps, now);
      this.deps.logger.debug({ count: apps.length }, 'Refreshed installed apps');
    } catch (err) {
      this.deps.logger.debug({ err: (err as Error).message }, 'Could not refresh apps');
    }
  }

  /**
   * "Limited mode" canary. Roku OS 14.1+ blocks /query/icon and keypress unless Control by mobile
   * apps is Enabled, while queries still work — so without this, enforcement would fail silently.
   */
  private async maybeProbeRestriction(now: number, client: EcpClientLike): Promise<void> {
    const intervalSec = this.deps.config.monitor.restrictionProbeIntervalSec;
    if (intervalSec <= 0) return;
    const interval = this.limited ? Math.min(LIMITED_REPROBE_MS, intervalSec * 1000) : intervalSec * 1000;
    if (now - this.lastProbeAt < interval) return;

    const appId =
      this.probeAppId ??
      this.deps.repos.apps.list({ installedOnly: true }).find((a) => a.type === 'appl')?.appId ??
      null;
    if (!appId) return;
    this.lastProbeAt = now;
    try {
      await client.icon(appId);
      this.probeAppId = appId;
      if (this.limited) this.deps.logger.info('ECP control access restored (Limited mode cleared)');
      this.limited = false;
    } catch (err) {
      if (isEcpError(err, 'restricted')) {
        if (!this.limited) this.deps.logger.warn({ appId }, 'Icon probe refused (HTTP 403) — ECP is in Limited mode');
        this.limited = true;
        this.probeAppId = appId;
      } else if (isEcpError(err, 'http')) {
        this.probeAppId = null; // app removed? pick another next time
      }
      // timeouts etc. are handled by the main poll path
    }
  }

  // ─── health ───────────────────────────────────────────────────────────────

  private setHealth(health: Health, restriction: Restriction | null, now: number): void {
    const prev = this.status.health;
    const prevRestriction = this.status.restriction;
    if (prev === health && prevRestriction === restriction) return;
    const message = healthMessage(health, restriction);
    this.status.health = health;
    this.status.restriction = restriction;
    this.status.message = message;
    this.status.healthSince = now;
    if (health !== 'online' && health !== 'tv_off' && health !== 'restricted') this.status.powerMode = null;

    const severity = healthSeverity(health);
    this.deps.repos.events.add({
      at: now,
      type: 'health',
      severity,
      message,
      data: { from: prev, to: health, restriction },
    });
    this.deps.logger[severity]({ from: prev, to: health, restriction }, `Health: ${message}`);
    this.deps.bus.emit('health', { at: now, from: prev, to: health, restriction, message });
  }
}
