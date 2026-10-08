import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import { z } from 'zod';
import { EnforcementConfigSchema, RulesConfigSchema, type EnforcementConfig } from '../config/rules-schema.js';
import {
  NotificationsConfigSchema,
  TvMessagesConfigSchema,
  type Config,
  type NotificationsConfig,
  type TvMessagesConfig,
} from '../config/schema.js';
import type { KeyValueRepo } from '../db/repo.js';
import { toRulesInput, type RulesInput } from '../rules/format.js';
import type { Rules } from '../rules/types.js';

/**
 * Effective, live-changeable settings. Precedence per section:
 *   dashboard (SQLite `settings` table, key "overlay.<section>")  >  config.json  >  defaults
 * A section edited in the dashboard fully replaces the config.json value for that section until
 * it is reset. config.json itself is hot-reloaded (reloadFile). Consumers read the getters on
 * every use, or listen for "change".
 */

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined));

export const DeviceSettingsSchema = z.object({ serial: optionalString, host: optionalString }).strict();
export const MonitorSettingsSchema = z.object({ pollIntervalSec: z.number().min(1).max(300) }).strict();

const SECTIONS = {
  rules: RulesConfigSchema,
  enforcement: EnforcementConfigSchema,
  notifications: NotificationsConfigSchema,
  device: DeviceSettingsSchema,
  monitor: MonitorSettingsSchema,
  tvMessages: TvMessagesConfigSchema,
} as const;

export type Section = keyof typeof SECTIONS;
export type SectionSource = 'config.json' | 'dashboard';

interface Effective {
  rules: Rules;
  enforcement: EnforcementConfig;
  notifications: NotificationsConfig;
  device: { serial: string | undefined; host: string | undefined };
  monitor: { pollIntervalSec: number };
  tvMessages: TvMessagesConfig;
}

export class SettingsValidationError extends Error {
  override readonly name = 'SettingsValidationError';
  constructor(
    readonly section: Section,
    readonly issues: string,
  ) {
    super(`Invalid ${section} settings:\n${issues}`);
  }
}

export class RuntimeConfig extends EventEmitter<{ change: [Section[]] }> {
  private file: Config;
  private eff!: Effective;
  private src!: Record<Section, SectionSource>;

  constructor(
    file: Config,
    private readonly settings: KeyValueRepo,
    private readonly logger: Logger,
  ) {
    super();
    this.file = file;
    this.recompute();
  }

  get rules(): Rules {
    return this.eff.rules;
  }
  get enforcement(): EnforcementConfig {
    return this.eff.enforcement;
  }
  get notifications(): NotificationsConfig {
    return this.eff.notifications;
  }
  get device(): Effective['device'] {
    return this.eff.device;
  }
  get pollIntervalSec(): number {
    return this.eff.monitor.pollIntervalSec;
  }
  get tvMessages(): TvMessagesConfig {
    return this.eff.tvMessages;
  }
  /** Settings that are fixed for the process lifetime. */
  get base(): Config {
    return this.file;
  }
  sources(): Record<Section, SectionSource> {
    return { ...this.src };
  }

  /** The editable form of a section as currently in effect. */
  inputFor(section: 'rules'): RulesInput;
  inputFor(section: Exclude<Section, 'rules'>): unknown;
  inputFor(section: Section): unknown {
    if (section === 'rules') return toRulesInput(this.eff.rules);
    return structuredClone(this.eff[section]);
  }

  /** Validate and store a dashboard edit. Throws SettingsValidationError. */
  update(section: Section, input: unknown): void {
    const parsed = SECTIONS[section].safeParse(input);
    if (!parsed.success) throw new SettingsValidationError(section, z.prettifyError(parsed.error));
    this.settings.set(`overlay.${section}`, input, Date.now());
    this.logger.info({ section }, 'Settings updated from the dashboard');
    this.apply([section]);
  }

  /** Drop the dashboard value for a section, falling back to config.json. */
  reset(section: Section): void {
    this.settings.delete(`overlay.${section}`);
    this.logger.info({ section }, 'Settings reset to config.json');
    this.apply([section]);
  }

  /** Swap in a re-read config.json (only the live sections take effect). */
  reloadFile(next: Config): Section[] {
    this.file = next;
    return this.apply(Object.keys(SECTIONS) as Section[]);
  }

  private apply(candidates: Section[]): Section[] {
    const before = JSON.stringify(this.eff);
    const prev = this.eff;
    this.recompute();
    const changed = candidates.filter((s) => JSON.stringify(prev[s]) !== JSON.stringify(this.eff[s]));
    if (changed.length && before !== JSON.stringify(this.eff)) this.emit('change', changed);
    return changed;
  }

  private overlay<S extends Section>(section: S): z.output<(typeof SECTIONS)[S]> | undefined {
    const stored = this.settings.get<unknown>(`overlay.${section}`);
    if (!stored) return undefined;
    const parsed = SECTIONS[section].safeParse(stored.value);
    if (!parsed.success) {
      this.logger.error({ section, issues: z.prettifyError(parsed.error) }, 'Ignoring invalid dashboard settings');
      return undefined;
    }
    return parsed.data as z.output<(typeof SECTIONS)[S]>;
  }

  private recompute(): void {
    const f = this.file;
    const rules = this.overlay('rules');
    const enforcement = this.overlay('enforcement');
    const notifications = this.overlay('notifications');
    const device = this.overlay('device');
    const monitor = this.overlay('monitor');
    const tvMessages = this.overlay('tvMessages');
    this.eff = {
      rules: rules ?? f.rules,
      enforcement: enforcement ?? f.enforcement,
      notifications: notifications ?? f.notifications,
      device: device ?? { serial: f.device.serial, host: f.device.host },
      monitor: monitor ?? { pollIntervalSec: f.monitor.pollIntervalSec },
      tvMessages: tvMessages ?? f.tvMessages,
    };
    this.src = {
      rules: rules ? 'dashboard' : 'config.json',
      enforcement: enforcement ? 'dashboard' : 'config.json',
      notifications: notifications ? 'dashboard' : 'config.json',
      device: device ? 'dashboard' : 'config.json',
      monitor: monitor ? 'dashboard' : 'config.json',
      tvMessages: tvMessages ? 'dashboard' : 'config.json',
    };
  }
}
