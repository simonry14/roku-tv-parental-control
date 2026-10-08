import type { Logger } from 'pino';
import type { EnforcementConfig } from '../config/rules-schema.js';
import type { TvMessagesConfig } from '../config/schema.js';
import type { Repos } from '../db/repo.js';
import { isEcpError, type EcpKey } from '../ecp/types.js';
import type { GuardianBus } from '../lib/bus.js';
import { localDayRange, type Clock } from '../lib/time.js';
import type { Observation } from '../monitor/observation.js';
import type { ObservationEvent } from '../monitor/status.js';
import { evaluate } from '../rules/engine.js';
import { allowedUntil } from '../rules/schedule.js';
import type { Decision, ReasonCode, Rules } from '../rules/types.js';
import type { UsageService } from '../usage/usage.js';
import type { MessageKey, TvTexts } from './message-catalog.js';
import { TvMessenger, type ChannelControl } from './messenger.js';
import {
  cleanMessageText,
  enforcementMessage,
  parentMessage,
  previewTvMessage,
  testMessage,
  warningMessage,
  type TvMessage,
} from './tv-messages.js';

export interface EnforcementEvent {
  at: number;
  action: 'home' | 'power_off';
  reason: ReasonCode;
  /** Set when repeated app violations escalated a Home into a PowerOff. */
  escalatedFrom: ReasonCode | null;
  message: string;
  appId: string | null;
  appName: string | null;
  mode: 'dry-run' | 'enforce';
  result: 'sent' | 'dry-run' | 'failed';
  error: string | null;
  /** What the Parental Control channel showed (instead of a Home press, or before a PowerOff). */
  shown: { title: string; countdownSec: number } | null;
  /** A PowerOff follows when the on-screen countdown ends. */
  pendingUntil: number | null;
  /** The PowerOff at the end of a countdown (the action was already reported when it began). */
  afterCountdown: boolean;
}

/** What the enforcer needs from the poller. */
export interface TvControl extends ChannelControl {
  sendKey(key: EcpKey): Promise<void>;
  pollNow(): void;
  reportControlRestricted(): void;
}

export interface EnforcerDeps {
  bus: GuardianBus;
  repos: Repos;
  usage: UsageService;
  control: TvControl;
  /** Read on every evaluation so config reloads take effect immediately. */
  getRules(): Rules;
  getSettings(): EnforcementConfig;
  getTvMessages(): TvMessagesConfig;
  zone: string;
  clock: Clock;
  logger: Logger;
  /** Timer for countdown ends (default setTimeout). Tests drive polls themselves. */
  schedule?: (ms: number, fn: () => void) => void;
}

/** A PowerOff waiting for the countdown on the TV to finish. */
export interface Countdown {
  reason: ReasonCode;
  escalatedFrom: ReasonCode | null;
  startedAt: number;
  endsAt: number;
  title: string;
  why: string;
  appId: string | null;
  appName: string | null;
  /** Parent-initiated (dashboard lock): goes ahead whatever the enforcement mode. */
  force: boolean;
}

export class TvMessageError extends Error {
  override readonly name = 'TvMessageError';
  constructor(
    readonly kind: 'tv_off' | 'not_installed' | 'disabled' | 'busy' | 'failed',
    message: string,
  ) {
    super(message);
  }
}

const KEY: Record<'home' | 'power_off', EcpKey> = { home: 'Home', power_off: 'PowerOff' };
const VERB: Record<'home' | 'power_off', string> = { home: 'Home', power_off: 'PowerOff' };
const MIN = 60_000;
/** A TV switched back on this soon after a PowerOff gets the short countdown. */
const RECENT_POWER_OFF_MS = 10 * MIN;
/** After a warning or message, a press of OK (→ Home) within this long still returns to the show. */
const RETURN_GRACE_MS = 20_000;

interface ActContext {
  decision: Decision;
  reason: ReasonCode;
  escalatedFrom: ReasonCode | null;
  why: string;
  appId: string | null;
  appName: string | null;
  mode: 'dry-run' | 'enforce';
  now: number;
}

/**
 * Turns engine decisions into actions on the TV, safely:
 *   - cooldowns per action so we never spam keypresses (Home 10 s, PowerOff 15 s by default)
 *   - escalation: the Nth app-rule violation within M minutes powers off instead of Home
 *   - dry-run mode logs "would …" without touching the TV
 *   - HTTP 403 → poller.reportControlRestricted() (Limited/Disabled mode)
 *   - every action is written to the events table (type "enforcement") with its reason
 * With the Parental Control channel installed (tvMessages.enabled), it explains instead of just acting:
 *   - app rules: the channel opens with "YouTube isn't allowed" (it replaces the app, like Home)
 *   - power-offs: a message with a countdown, then PowerOff (cancelled if no longer needed)
 *   - optional warning N minutes before time runs out, then back to the show
 *   - parent messages from the dashboard
 * Without the channel it presses Home / PowerOff as before. All work runs one task at a time.
 */
export class Enforcer {
  private readonly lastSentAt: Record<'home' | 'power_off', number> = {
    home: Number.NEGATIVE_INFINITY,
    power_off: Number.NEGATIVE_INFINITY,
  };
  private violations: number[] = [];
  private lastDecision: Decision | null = null;
  private lastObservation: Observation | null = null;
  private countdown: Countdown | null = null;
  /** After a warning or message: reopen this app when it ends (or when OK sends the TV Home). */
  private returnTo: { appId: string; appName: string | null; at: number; until: number } | null = null;
  /** Warnings already shown today (keys are prefixed with the local day). */
  private readonly warned = new Set<string>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private queue: Promise<unknown> = Promise.resolve();
  private queued = 0;
  readonly tv: TvMessenger;

  private readonly onObservation = (ev: ObservationEvent): void => {
    if (this.queued > 0) return; // still acting on an earlier poll; the next one re-evaluates
    this.enqueue(() => this.handle(ev.observation, ev.at)).catch((err: unknown) =>
      this.deps.logger.error({ err }, 'Enforcer failed'),
    );
  };

  constructor(private readonly deps: EnforcerDeps) {
    this.tv = new TvMessenger({
      control: deps.control,
      apps: deps.repos.apps,
      getConfig: deps.getTvMessages,
      clock: deps.clock,
      logger: deps.logger,
    });
  }

  start(): void {
    this.deps.bus.on('observation', this.onObservation);
  }

  stop(): Promise<unknown> {
    this.deps.bus.off('observation', this.onObservation);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    return this.idle();
  }

  /** Resolves when queued work is done. For tests. */
  idle(): Promise<unknown> {
    return this.queue;
  }

  getLastDecision(): Decision | null {
    return this.lastDecision;
  }

  getCountdown(): Countdown | null {
    return this.countdown ? { ...this.countdown } : null;
  }

  /** Evaluate the rules for an observation using today's usage, override and bonus. No side effects. */
  decide(observation: Observation, now: number): Decision {
    const { repos, usage, zone } = this.deps;
    const today = usage.forDay(now);
    return evaluate({
      observation,
      rules: this.deps.getRules(),
      usage: { screenMs: today.screenMs, byApp: Object.fromEntries(today.byApp.map((a) => [a.appId, a.ms])) },
      override: repos.overrides.get(),
      bonusMinutes: repos.overrides.bonusFor(today.range.day),
      now,
      zone,
    });
  }

  /** Evaluate and, if needed, act. Returns the enforcement event, or null if nothing was done. */
  async handle(observation: Observation, now: number): Promise<EnforcementEvent | null> {
    const { repos, logger } = this.deps;
    const settings = this.deps.getSettings();
    const decision = this.decide(observation, now);
    this.lastDecision = decision;
    this.lastObservation = observation;
    repos.runtime.set('decision', { ...decision, mode: settings.mode }, now);

    if (this.countdown) return this.continueCountdown(observation, decision, now);
    if (this.returnTo) await this.maybeReturn(observation, decision, now);

    if (settings.mode === 'off') return null;
    if (decision.action === 'none' || decision.reason === null) {
      await this.maybeWarn(observation, decision, now, settings.mode);
      return null;
    }

    let action = decision.action;
    if (now - this.lastSentAt[action] < this.cooldownMs(action, settings)) {
      logger.debug({ action, reason: decision.reason }, 'Enforcement skipped (cooldown)');
      return null;
    }

    // Escalation: repeated app-rule violations → PowerOff.
    let escalatedFrom: ReasonCode | null = null;
    if (action === 'home' && settings.escalation.repeats > 0) {
      const windowMs = settings.escalation.windowMin * MIN;
      this.violations = this.violations.filter((t) => now - t < windowMs);
      if (this.violations.length + 1 >= settings.escalation.repeats) {
        escalatedFrom = decision.reason;
        action = 'power_off';
        this.violations = [];
      } else {
        this.violations.push(now);
      }
    }

    const ctx: ActContext = {
      decision,
      reason: decision.reason,
      escalatedFrom,
      why: escalatedFrom
        ? `${decision.message} — repeated ${settings.escalation.repeats}× within ${settings.escalation.windowMin} min`
        : decision.message,
      appId: decision.appId,
      appName: decision.appName,
      mode: settings.mode,
      now,
    };
    const tvCfg = this.deps.getTvMessages();
    const screenOn = observation.status === 'watching';
    const useTv = screenOn && this.tv.ready(now);
    const onScreen = screenOn && observation.kind === 'app' ? observation.appId : null;

    if (action === 'home') {
      if (useTv) return this.showInsteadOfHome(ctx, onScreen);
      return this.pressKey('home', ctx);
    }

    const recent = now - this.lastSentAt.power_off < RECENT_POWER_OFF_MS;
    const seconds =
      escalatedFrom || decision.reason === 'lock' || recent ? tvCfg.shortCountdownSec : tvCfg.countdownSec;
    if (useTv && seconds > 0) return this.startCountdown(ctx, seconds, onScreen, false);
    return this.pressKey('power_off', ctx);
  }

  // ─── Parent actions (dashboard) ───────────────────────────────────────────

  /**
   * Lock from the dashboard: the lock override is already set; turn the TV off now, after a short
   * countdown on screen when the channel is there. Acts whatever the enforcement mode.
   */
  lockNow(): Promise<string> {
    return this.enqueue(async () => {
      const { clock, control, logger } = this.deps;
      const now = clock.now();
      const obs = this.lastObservation;
      const seconds = this.deps.getTvMessages().shortCountdownSec;
      if (obs?.status === 'watching' && seconds > 0 && !this.countdown && this.tv.ready(now)) {
        const decision = this.decide(obs, now);
        if (decision.reason === 'lock') {
          const ev = await this.startCountdown(
            {
              decision,
              reason: 'lock',
              escalatedFrom: null,
              why: decision.message,
              appId: decision.appId,
              appName: decision.appName,
              mode: 'enforce',
              now,
            },
            seconds,
            obs.kind === 'app' ? obs.appId : null,
            true,
          );
          if (ev?.pendingUntil) return `the TV turns off in ${seconds} seconds`;
        }
      }
      try {
        await control.sendKey('PowerOff');
        this.lastSentAt.power_off = now;
        control.pollNow();
        return 'TV turned off';
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'Lock: could not send PowerOff');
        return `could not reach the TV (${(err as Error).message})`;
      }
    });
  }

  /** Show a parent's message on the TV. Throws TvMessageError. */
  sendMessage(text: string, opts: { returnToShow: boolean }): Promise<string> {
    return this.enqueue(async () => {
      const { clock, repos, control } = this.deps;
      const now = clock.now();
      const obs = this.requireTv(now);
      const prev =
        obs.kind === 'app' && obs.appId && obs.appId !== this.tv.appId
          ? { appId: obs.appId, appName: obs.appName }
          : null;
      const returnSec = opts.returnToShow && prev ? this.deps.getTvMessages().messageSec : 0;
      const msg = parentMessage(text, {
        returnSec,
        appName: prev?.appName ?? null,
        texts: this.deps.getTvMessages().texts,
      });
      await this.showOrThrow(msg, obs.kind === 'app' ? obs.appId : null);
      if (returnSec && prev) this.setReturn(prev.appId, prev.appName, now + returnSec * 1000);
      repos.events.add({
        at: now,
        type: 'message',
        severity: 'info',
        message: `Message shown on the TV: “${cleanMessageText(text)}”`,
      });
      control.pollNow();
      return 'Message shown on the TV';
    });
  }

  /**
   * Message editor → "Show on the TV": one message with example values, using the words being
   * edited (not yet saved). Closable with OK; nothing else happens. Throws TvMessageError.
   */
  sendPreview(key: MessageKey, texts: TvTexts): Promise<string> {
    return this.enqueue(async () => {
      const now = this.deps.clock.now();
      const obs = this.requireTv(now);
      await this.showOrThrow(previewTvMessage(key, texts), obs.kind === 'app' ? obs.appId : null);
      this.deps.control.pollNow();
      return 'Showing it on the TV. Press OK on the remote to close it.';
    });
  }

  /** Settings → "Show a test message". Throws TvMessageError. */
  sendTestMessage(): Promise<string> {
    return this.enqueue(async () => {
      const now = this.deps.clock.now();
      const obs = this.requireTv(now);
      await this.showOrThrow(testMessage(), obs.kind === 'app' ? obs.appId : null);
      this.deps.control.pollNow();
      return 'Test message shown on the TV';
    });
  }

  // ─── Acting ───────────────────────────────────────────────────────────────

  private async pressKey(
    action: 'home' | 'power_off',
    ctx: ActContext,
    extra: { afterCountdown?: boolean; note?: string } = {},
  ): Promise<EnforcementEvent> {
    const { control } = this.deps;
    let result: EnforcementEvent['result'] = 'dry-run';
    let error: string | null = null;
    if (ctx.mode === 'enforce') {
      try {
        await control.sendKey(KEY[action]);
        result = 'sent';
      } catch (err) {
        result = 'failed';
        error = (err as Error).message;
        if (isEcpError(err, 'restricted')) control.reportControlRestricted();
      }
    }
    this.lastSentAt[action] = ctx.now; // also after failures, so a broken TV isn't hammered
    const why = extra.note ? `${ctx.why} (${extra.note})` : ctx.why;
    const message =
      result === 'dry-run'
        ? `Practice mode: would send ${VERB[action]} — ${why}`
        : result === 'sent'
          ? `Sent ${VERB[action]} — ${why}`
          : `Could not send ${VERB[action]} (${error}) — ${why}`;
    const ev = this.record(action, ctx, { message, result, error, afterCountdown: extra.afterCountdown ?? false });
    if (result === 'sent') control.pollNow();
    return ev;
  }

  /** App rules with the channel: open it with the reason (it replaces the app, as Home would). */
  private async showInsteadOfHome(ctx: ActContext, onScreen: string | null): Promise<EnforcementEvent> {
    const msg = enforcementMessage({
      decision: ctx.decision,
      rules: this.deps.getRules(),
      override: this.deps.repos.overrides.get(),
      escalated: false,
      countdownSec: 0,
      texts: this.deps.getTvMessages().texts,
      now: ctx.now,
      zone: this.deps.zone,
    });
    if (ctx.mode !== 'enforce') {
      this.lastSentAt.home = ctx.now;
      return this.record('home', ctx, {
        message: `Practice mode: would show “${msg.title}” on the TV — ${ctx.why}`,
        result: 'dry-run',
        shown: { title: msg.title, countdownSec: 0 },
      });
    }
    try {
      await this.tv.show(msg, onScreen);
    } catch (err) {
      if (isEcpError(err, 'restricted')) return this.failRestricted('home', ctx, err);
      this.deps.logger.warn({ err: (err as Error).message }, 'Could not open the message channel; pressing Home');
      return this.pressKey('home', ctx);
    }
    this.lastSentAt.home = ctx.now;
    this.deps.control.pollNow();
    return this.record('home', ctx, {
      message: `Showed “${msg.title}” on the TV — ${ctx.why}`,
      result: 'sent',
      shown: { title: msg.title, countdownSec: 0 },
    });
  }

  /** Power-off with the channel: show why, count down, then PowerOff (continueCountdown). */
  private async startCountdown(
    ctx: ActContext,
    seconds: number,
    onScreen: string | null,
    force: boolean,
  ): Promise<EnforcementEvent> {
    const msg = enforcementMessage({
      decision: ctx.decision,
      rules: this.deps.getRules(),
      override: this.deps.repos.overrides.get(),
      escalated: ctx.escalatedFrom !== null,
      countdownSec: seconds,
      texts: this.deps.getTvMessages().texts,
      now: ctx.now,
      zone: this.deps.zone,
    });
    const shown = { title: msg.title, countdownSec: seconds };
    if (ctx.mode !== 'enforce' && !force) {
      this.lastSentAt.power_off = ctx.now;
      return this.record('power_off', ctx, {
        message: `Practice mode: would show “${msg.title}” on the TV, then send PowerOff after ${seconds} s — ${ctx.why}`,
        result: 'dry-run',
        shown,
      });
    }
    try {
      await this.tv.show(msg, onScreen);
    } catch (err) {
      if (isEcpError(err, 'restricted')) return this.failRestricted('power_off', ctx, err);
      this.deps.logger.warn({ err: (err as Error).message }, 'Could not open the message channel; powering off now');
      return this.pressKey('power_off', { ...ctx, mode: 'enforce' });
    }
    const endsAt = ctx.now + seconds * 1000;
    this.countdown = {
      reason: ctx.reason,
      escalatedFrom: ctx.escalatedFrom,
      startedAt: ctx.now,
      endsAt,
      title: msg.title,
      why: ctx.why,
      appId: ctx.appId,
      appName: ctx.appName,
      force,
    };
    this.wakeAt(endsAt);
    this.deps.control.pollNow();
    return this.record(
      'power_off',
      { ...ctx, mode: 'enforce' },
      {
        message: `Showed “${msg.title}” on the TV, turning off in ${seconds} s — ${ctx.why}`,
        result: 'sent',
        shown,
        pendingUntil: endsAt,
      },
    );
  }

  private async continueCountdown(
    observation: Observation,
    decision: Decision,
    now: number,
  ): Promise<EnforcementEvent | null> {
    const c = this.countdown!;
    const { logger, repos, control } = this.deps;
    if (observation.status === 'unknown') {
      // Can't see the TV: keep waiting a little, then give up (the next poll re-evaluates).
      if (now > c.endsAt + MIN) this.countdown = null;
      return null;
    }
    const mode = this.deps.getSettings().mode;
    const wanted =
      observation.status !== 'off' &&
      !decision.paused &&
      (c.force || mode === 'enforce') &&
      (c.reason === 'lock' ? decision.reason === 'lock' : c.escalatedFrom !== null || decision.action === 'power_off');
    if (!wanted) {
      this.countdown = null;
      const why =
        observation.status === 'off'
          ? 'the TV was switched off'
          : decision.paused
            ? 'rules paused'
            : c.reason === 'lock'
              ? 'the TV was unlocked'
              : 'no longer needed';
      logger.info({ why }, 'Countdown stopped');
      repos.events.add({ at: now, type: 'enforcement', severity: 'info', message: `Countdown stopped: ${why}` });
      // Take the countdown off the screen.
      if (observation.status === 'watching' && observation.kind === 'app' && observation.appId === this.tv.appId) {
        await control.sendKey('Home').catch(() => undefined);
        control.pollNow();
      }
      return null;
    }
    if (now < c.endsAt) return null;
    this.countdown = null;
    return this.pressKey(
      'power_off',
      {
        decision,
        reason: c.reason,
        escalatedFrom: c.escalatedFrom,
        why: c.why,
        appId: c.appId,
        appName: c.appName,
        mode: 'enforce',
        now,
      },
      { afterCountdown: true },
    );
  }

  private failRestricted(action: 'home' | 'power_off', ctx: ActContext, err: unknown): EnforcementEvent {
    this.deps.control.reportControlRestricted();
    this.lastSentAt[action] = ctx.now;
    const error = (err as Error).message;
    return this.record(action, ctx, {
      message: `Could not show the message on the TV (${error}) — ${ctx.why}`,
      result: 'failed',
      error,
    });
  }

  // ─── Warnings and going back to the show ──────────────────────────────────

  private async maybeWarn(
    observation: Observation,
    decision: Decision,
    now: number,
    mode: 'dry-run' | 'enforce',
  ): Promise<void> {
    const cfg = this.deps.getTvMessages();
    if (cfg.warnBeforeMin <= 0 || decision.paused) return;
    if (observation.status !== 'watching' || observation.kind !== 'app' || !observation.appId) return;
    if (observation.appId === this.tv.appId) return;

    const thresholdMs = cfg.warnBeforeMin * MIN;
    const day = localDayRange(now, this.deps.zone).day;
    for (const k of this.warned) if (!k.startsWith(day)) this.warned.delete(k);

    const candidates: Array<{ key: string; scope: 'global' | 'app' | 'schedule'; left: number; endsAt: number }> = [];
    const { global, app } = decision.remainingMs;
    if (global !== null) candidates.push({ key: `${day}:global`, scope: 'global', left: global, endsAt: now + global });
    if (app !== null)
      candidates.push({ key: `${day}:app:${observation.appId}`, scope: 'app', left: app, endsAt: now + app });
    const until = allowedUntil(this.deps.getRules(), now, this.deps.zone);
    if (until !== null)
      candidates.push({ key: `${day}:schedule:${until}`, scope: 'schedule', left: until - now, endsAt: until });

    // Bonus time (or a new window) re-arms a warning.
    for (const c of candidates) if (c.left > thresholdMs + MIN) this.warned.delete(c.key);
    const due = candidates.filter((c) => c.left > 0 && c.left <= thresholdMs);
    const next = due.filter((c) => !this.warned.has(c.key)).sort((a, b) => a.left - b.left)[0];
    if (!next || !this.tv.ready(now)) return;
    for (const c of due) this.warned.add(c.key); // one interruption covers everything about to run out

    const msg = warningMessage({
      minutesLeft: Math.max(1, Math.ceil(next.left / MIN)),
      scope: next.scope,
      endsAt: next.endsAt,
      appName: observation.appName,
      returnSec: cfg.warningSec,
      texts: cfg.texts,
      now,
      zone: this.deps.zone,
    });
    const { repos, logger } = this.deps;
    if (mode !== 'enforce') {
      repos.events.add({
        at: now,
        type: 'message',
        severity: 'info',
        message: `Practice mode: would show “${msg.title}” on the TV`,
      });
      return;
    }
    try {
      await this.tv.show(msg, observation.appId);
    } catch (err) {
      if (isEcpError(err, 'restricted')) this.deps.control.reportControlRestricted();
      logger.warn({ err: (err as Error).message }, 'Could not show the warning');
      return;
    }
    this.setReturn(observation.appId, observation.appName, now + cfg.warningSec * 1000);
    repos.events.add({ at: now, type: 'message', severity: 'info', message: `Showed “${msg.title}” on the TV` });
    logger.info({ title: msg.title }, 'Warning shown on the TV');
    this.deps.control.pollNow();
  }

  private setReturn(appId: string, appName: string | null, at: number): void {
    this.returnTo = { appId, appName, at, until: at + RETURN_GRACE_MS };
    this.wakeAt(at);
  }

  /** After a warning/message: reopen the app when it ends, or right away if OK took the TV Home. */
  private async maybeReturn(observation: Observation, decision: Decision, now: number): Promise<void> {
    const r = this.returnTo!;
    if (observation.status === 'unknown') return;
    const onChannel =
      observation.status === 'watching' && observation.kind === 'app' && observation.appId === this.tv.appId;
    const onHome = observation.status === 'watching' && observation.kind === 'home';
    if ((!onChannel && !onHome) || decision.action !== 'none' || (onHome && now > r.until)) {
      this.returnTo = null; // they moved on, the TV went off, or a rule now applies
      return;
    }
    if (onChannel && now < r.at) return;
    this.returnTo = null;
    try {
      await this.deps.control.launch(r.appId);
      this.deps.logger.info({ app: r.appName }, 'Back to the show');
      this.deps.control.pollNow();
    } catch (err) {
      this.deps.logger.warn({ err: (err as Error).message, app: r.appName }, 'Could not reopen the app');
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private requireTv(now: number): Extract<Observation, { status: 'watching' }> {
    const obs = this.lastObservation;
    const cfg = this.deps.getTvMessages();
    if (!cfg.enabled) throw new TvMessageError('disabled', 'TV messages are switched off in Settings.');
    if (!this.tv.installed())
      throw new TvMessageError(
        'not_installed',
        'The Parental Control channel isn’t on the TV yet. Install it on the PC with: npm run channel:install',
      );
    if (!obs || obs.status !== 'watching')
      throw new TvMessageError('tv_off', 'The TV is off, so there’s nowhere to show it.');
    if (this.countdown)
      throw new TvMessageError(
        'busy',
        `The TV is switching off in ${Math.max(0, Math.ceil((this.countdown.endsAt - now) / 1000))} s.`,
      );
    return obs;
  }

  private async showOrThrow(msg: TvMessage, onScreen: string | null): Promise<void> {
    try {
      await this.tv.show(msg, onScreen);
    } catch (err) {
      if (isEcpError(err, 'restricted')) this.deps.control.reportControlRestricted();
      throw new TvMessageError('failed', `The TV didn’t open the message: ${(err as Error).message}`);
    }
  }

  private record(
    action: 'home' | 'power_off',
    ctx: ActContext,
    r: {
      message: string;
      result: EnforcementEvent['result'];
      error?: string | null;
      shown?: EnforcementEvent['shown'];
      pendingUntil?: number | null;
      afterCountdown?: boolean;
    },
  ): EnforcementEvent {
    const { repos, logger, bus } = this.deps;
    const ev: EnforcementEvent = {
      at: ctx.now,
      action,
      reason: ctx.reason,
      escalatedFrom: ctx.escalatedFrom,
      message: r.message,
      appId: ctx.appId,
      appName: ctx.appName,
      mode: ctx.mode,
      result: r.result,
      error: r.error ?? null,
      shown: r.shown ?? null,
      pendingUntil: r.pendingUntil ?? null,
      afterCountdown: r.afterCountdown ?? false,
    };
    repos.events.add({
      at: ctx.now,
      type: 'enforcement',
      severity: r.result === 'failed' ? 'error' : action === 'power_off' ? 'warn' : 'info',
      message: r.message,
      data: ev,
    });
    logger[r.result === 'failed' ? 'error' : 'warn'](
      { action, reason: ctx.reason, app: ctx.appName, mode: ctx.mode, result: r.result },
      r.message,
    );
    bus.emit('enforcement', ev);
    return ev;
  }

  private wakeAt(at: number): void {
    const ms = Math.max(0, at - this.deps.clock.now()) + 250;
    const poll = (): void => this.deps.control.pollNow();
    if (this.deps.schedule) return this.deps.schedule(ms, poll);
    const t = setTimeout(() => {
      this.timers.delete(t);
      poll();
    }, ms);
    t.unref();
    this.timers.add(t);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    this.queued++;
    const run = this.queue.then(fn).finally(() => {
      this.queued--;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private cooldownMs(action: 'home' | 'power_off', s: EnforcementConfig): number {
    return (action === 'home' ? s.cooldownSec : s.powerOffCooldownSec) * 1000;
  }
}
