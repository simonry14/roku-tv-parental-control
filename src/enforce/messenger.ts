import type { Logger } from 'pino';
import type { TvMessagesConfig } from '../config/schema.js';
import type { AppsRepo } from '../db/repo.js';
import { isEcpError } from '../ecp/types.js';
import type { Clock } from '../lib/time.js';
import { toChannelParams, type TvMessage } from './tv-messages.js';

export interface ChannelControl {
  launch(appId: string, params?: Record<string, string>): Promise<void>;
  input(params: Record<string, string>): Promise<void>;
  /** Asked right before showing: the last poll may be seconds old. */
  foregroundAppId(): Promise<string | null>;
  refreshApps(): void;
}

/** After the TV says the channel isn't there (404), stop trying it for this long. */
const MISSING_BACKOFF_MS = 10 * 60_000;

/**
 * Puts a message on the TV with the sideloaded Parental Control channel: /launch/dev?… when another
 * app is on screen, /input?… when the channel is already open (it swaps the message in place).
 * "Installed" comes from the TV's own channel list (refreshed by the poller).
 */
export class TvMessenger {
  private missingUntil = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly deps: {
      control: ChannelControl;
      apps: AppsRepo;
      getConfig(): TvMessagesConfig;
      clock: Clock;
      logger: Logger;
    },
  ) {}

  get appId(): string {
    return this.deps.getConfig().appId;
  }

  installed(): boolean {
    const id = this.appId;
    return this.deps.apps.list({ installedOnly: true }).some((a) => a.appId === id);
  }

  /** Enabled, installed, and not recently reported missing. */
  ready(now = this.deps.clock.now()): boolean {
    return this.deps.getConfig().enabled && now >= this.missingUntil && this.installed();
  }

  /**
   * Throws EcpError (restricted on 403, http 404 if the channel is gone). `lastSeenAppId` is what
   * the last poll saw; the TV is asked again only when that was the channel itself.
   */
  async show(msg: TvMessage, lastSeenAppId: string | null): Promise<void> {
    const params = toChannelParams(msg);
    const { control, logger } = this.deps;
    try {
      const open = lastSeenAppId === this.appId && (await control.foregroundAppId().catch(() => null)) === this.appId;
      if (open) {
        try {
          await control.input(params);
          return;
        } catch (err) {
          if (isEcpError(err, 'restricted')) throw err;
          logger.debug({ err: (err as Error).message }, 'input to the open channel failed; relaunching it');
        }
      }
      await control.launch(this.appId, params);
    } catch (err) {
      if (isEcpError(err, 'http') && err.details.status === 404) {
        this.missingUntil = this.deps.clock.now() + MISSING_BACKOFF_MS;
        logger.warn('The Parental Control channel is not on the TV any more; using Home/PowerOff until it is back');
        control.refreshApps();
      }
      throw err;
    }
  }
}
