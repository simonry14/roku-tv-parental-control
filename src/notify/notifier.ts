import type { Logger } from 'pino';
import type { NotificationsConfig } from '../config/schema.js';
import type { EventsRepo } from '../db/repo.js';
import type { EnforcementEvent } from '../enforce/enforcer.js';
import type { GuardianBus } from '../lib/bus.js';
import { localDayRange, type Clock } from '../lib/time.js';
import type { HealthChangeEvent, ObservationEvent } from '../monitor/status.js';
import type { NtfyClient, PushMessage } from './ntfy.js';

const MIN = 60_000;
const DEBOUNCE = {
  blocked: 10 * MIN,
  schedule: 30 * MIN,
  restricted: 60 * MIN,
};

/**
 * Turns bus events into push notifications, with debouncing so a determined kid doesn't turn
 * the parent's phone into a pager:
 *   blocked app attempted    once per app per 10 min
 *   budget exhausted         once per app (or global) per day
 *   TV on in quiet/off hours once per 30 min
 *   ECP restricted (tamper)  on transition, at most hourly; plus "restored" when it recovers
 *   TV unreachable           once per outage, only after `unreachableAfterMin`
 *   dashboard PIN lockout    always
 * Dry-run actions are skipped unless `includeDryRun`.
 */
export class Notifier {
  private readonly last = new Map<string, number>();
  private restrictedNotified = false;
  private offlineNotified = false;

  private readonly onEnforcement = (e: EnforcementEvent): void => void this.handleEnforcement(e);
  private readonly onHealth = (e: HealthChangeEvent): void => void this.handleHealth(e);
  private readonly onObservation = (e: ObservationEvent): void => void this.handleObservation(e);

  constructor(
    private readonly deps: {
      bus: GuardianBus;
      ntfy: NtfyClient;
      getConfig: () => NotificationsConfig;
      events?: EventsRepo;
      clock: Clock;
      zone: string;
      logger: Logger;
    },
  ) {}

  start(): void {
    this.deps.bus.on('enforcement', this.onEnforcement);
    this.deps.bus.on('health', this.onHealth);
    this.deps.bus.on('observation', this.onObservation);
  }

  stop(): void {
    this.deps.bus.off('enforcement', this.onEnforcement);
    this.deps.bus.off('health', this.onHealth);
    this.deps.bus.off('observation', this.onObservation);
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    return this.deps.ntfy.send(
      {
        title: 'TV Parental Control',
        message: 'Test notification — notifications are working.',
        tags: ['white_check_mark'],
      },
      { force: true },
    );
  }

  async loginLockout(until: number): Promise<void> {
    await this.push('lockout', 0, {
      title: 'Dashboard locked',
      message: `Several wrong PINs were entered on the Roku TV Parental Control dashboard. Logins are blocked until ${new Date(until).toLocaleTimeString('en-US', { timeZone: this.deps.zone, hour: 'numeric', minute: '2-digit' })}.`,
      priority: 4,
      tags: ['lock'],
    });
  }

  async handleEnforcement(e: EnforcementEvent): Promise<void> {
    const cfg = this.deps.getConfig();
    if (e.mode === 'dry-run' && !cfg.includeDryRun) return;
    if (e.afterCountdown) return; // already reported when the countdown began
    const dry = e.mode === 'dry-run' ? ' (practice mode)' : '';
    const failed = e.result === 'failed' ? ` — but the TV could not be controlled: ${e.error}` : '';
    const app = e.appName ?? e.appId ?? 'An app';

    switch (e.reason) {
      case 'app_blocked': {
        if (!cfg.events.blockedApp) return;
        const title = e.escalatedFrom ? `TV turned off${dry}` : `Blocked app opened${dry}`;
        const message = e.escalatedFrom
          ? `${app} kept being reopened, so the TV ${e.pendingUntil ? 'is being' : 'was'} turned off${failed}.`
          : e.shown
            ? `${app} was opened and stopped with a message on the TV${failed}.`
            : `${app} was opened and sent back to Home${failed}.`;
        const key = `blocked:${e.appId}:${e.escalatedFrom ? 'off' : 'home'}`;
        await this.push(key, DEBOUNCE.blocked, { title, message, tags: ['no_entry'] });
        return;
      }
      case 'app_budget':
      case 'global_budget': {
        if (!cfg.events.budgetExhausted) return;
        const day = localDayRange(e.at, this.deps.zone).day;
        const key = `budget:${day}:${e.reason === 'app_budget' ? e.appId : 'global'}`;
        await this.push(key, 24 * 60 * MIN, {
          title: `Time's up${dry}`,
          message: `${e.message.replace(/^.*? — /, '')}${failed}.`,
          tags: ['hourglass'],
        });
        return;
      }
      case 'quiet_hours':
      case 'outside_window': {
        if (!cfg.events.scheduleViolation) return;
        const what = e.reason === 'quiet_hours' ? 'during quiet hours' : 'outside viewing hours';
        await this.push(`schedule:${e.reason}`, DEBOUNCE.schedule, {
          title: `TV switched on ${what}${dry}`,
          message: `The TV was turned on ${what} and ${e.pendingUntil ? 'is being' : 'was'} switched off again${failed}.`,
          tags: ['crescent_moon'],
        });
        return;
      }
      case 'lock':
        return; // parent-initiated
    }
  }

  async handleHealth(e: HealthChangeEvent): Promise<void> {
    const cfg = this.deps.getConfig();
    if (e.to === 'restricted' && cfg.events.restricted) {
      this.restrictedNotified = await this.push(`restricted:${e.restriction}`, DEBOUNCE.restricted, {
        title: 'TV control blocked — possible tampering',
        message: e.message,
        priority: 5,
        tags: ['warning'],
      });
      return;
    }
    if (e.from === 'restricted' && (e.to === 'online' || e.to === 'tv_off') && this.restrictedNotified) {
      this.restrictedNotified = false;
      await this.push('restored', 0, {
        title: 'TV control restored',
        message: 'The TV is accepting commands again.',
        tags: ['white_check_mark'],
      });
    }
    if (e.from === 'offline' && e.to !== 'offline' && this.offlineNotified) {
      this.offlineNotified = false;
      await this.push('reachable', 0, {
        title: 'TV reachable again',
        message: 'The TV is back on the network.',
        tags: ['tv'],
      });
    }
  }

  async handleObservation(e: ObservationEvent): Promise<void> {
    const cfg = this.deps.getConfig();
    const s = e.status;
    if (s.health !== 'offline' && s.health !== 'searching') {
      return;
    }
    if (!cfg.events.unreachable || this.offlineNotified) return;
    const downFor = e.at - s.healthSince;
    if (downFor < cfg.unreachableAfterMin * MIN) return;
    this.offlineNotified = true;
    await this.push('unreachable', 0, {
      title: 'TV unreachable',
      message: `Roku TV Parental Control hasn't been able to reach the TV for ${Math.round(downFor / MIN)} minutes. It may be unplugged, off the Wi-Fi, or turned off without Fast TV start.`,
      priority: 4,
      tags: ['electric_plug'],
    });
  }

  /** Send unless the same key was sent within `debounceMs`. Returns true if a push went out. */
  private async push(key: string, debounceMs: number, msg: PushMessage): Promise<boolean> {
    const { ntfy, clock, logger, events } = this.deps;
    if (!ntfy.isConfigured()) return false;
    const now = clock.now();
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < debounceMs) return false;
    this.last.set(key, now);
    const res = await ntfy.send(msg);
    if (res.ok) {
      events?.add({
        at: now,
        type: 'notification',
        severity: 'info',
        message: `Notified: ${msg.title}`,
        data: { key },
      });
    } else {
      logger.warn({ key, error: res.error }, 'Notification failed');
    }
    return res.ok;
  }
}
