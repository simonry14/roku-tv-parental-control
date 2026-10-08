import { IANAZone } from 'luxon';
import { z } from 'zod';
import {
  CATALOG_BY_KEY,
  compactTexts,
  MESSAGE_KEYS,
  textFor,
  textProblems,
  type MessageKey,
  type TvTexts,
} from '../enforce/message-catalog.js';
import { EnforcementConfigSchema, RulesConfigSchema } from './rules-schema.js';

/**
 * Configuration schema. Every field has a default so an empty `{}` config is valid.
 *
 * Precedence (lowest → highest): these defaults → config.json → dashboard settings table
 * (for the dashboard-editable sections; see src/settings/runtime.ts).
 *
 * Nested objects use `.prefault({})` (not `.default({})`) so that zod v4 parses the empty
 * object through the inner schema and applies the inner defaults.
 */

const port = z.number().int().min(1).max(65535);

/** Optional string where "" (as in config.example.json) means "not set". */
const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined));

const timezone = z
  .string()
  .refine((tz) => IANAZone.isValidZone(tz), { message: 'Must be a valid IANA time zone, e.g. "America/New_York"' });

export const DeviceConfigSchema = z
  .object({
    /** Pin the TV by serial number. If omitted, the first TV found is pinned automatically. */
    serial: optionalString,
    /** Manual IP/hostname. Tried first; discovery is the fallback if it stops answering. */
    host: optionalString,
    port: port.default(8060),
  })
  .strict();

export const DiscoveryConfigSchema = z
  .object({
    /** How long to wait for SSDP replies per attempt. */
    ssdpTimeoutMs: z.number().int().min(500).max(15_000).default(3000),
    /** Restrict SSDP/scan to these local IPv4 addresses (default: every non-internal IPv4 interface). */
    interfaces: z.array(z.string().trim().min(1)).optional(),
    /** Fall back to probing port 8060 across the local subnet when SSDP finds nothing. */
    subnetScan: z.boolean().default(true),
    scanTimeoutMs: z.number().int().min(100).max(5000).default(800),
    scanConcurrency: z.number().int().min(1).max(256).default(48),
    /** Minimum time between two subnet scans (they are comparatively expensive). */
    scanMinIntervalSec: z.number().int().min(30).default(600),
    /** Consecutive failed polls before we try to rediscover the TV (DHCP address change). */
    rediscoverAfterFailures: z.number().int().min(1).default(3),
    /** Minimum time between rediscovery attempts while the TV stays unreachable. */
    rediscoverMinIntervalSec: z.number().int().min(10).default(120),
  })
  .strict();

export const MonitorConfigSchema = z
  .object({
    pollIntervalSec: z.number().min(1).max(300).default(5),
    requestTimeoutMs: z.number().int().min(250).max(30_000).default(2500),
    /**
     * If two consecutive successful polls are further apart than this, the time between them
     * is not counted (PC slept, service stalled, TV unreachable). Defaults to 3× poll interval, min 15s.
     */
    maxGapSec: z.number().min(2).optional(),
    /** Consecutive failures before health flips to offline (avoids flapping on a single timeout). */
    offlineAfterFailures: z.number().int().min(1).default(2),
    /** Ceiling for the poll interval while the TV is unreachable (exponential backoff). */
    offlineBackoffMaxSec: z.number().min(1).max(600).default(30),
    /**
     * Interval for the "Limited mode" canary: a harmless GET /query/icon/{id}. Roku OS 14.1+ blocks
     * icon + keypress (but not device-info/active-app) unless "Control by mobile apps" is Enabled,
     * so this detects silently-broken enforcement before we need it. 0 disables.
     */
    restrictionProbeIntervalSec: z.number().min(0).default(60),
    appsRefreshIntervalSec: z.number().min(30).default(900),
  })
  .strict();

export const UsageConfigSchema = z
  .object({
    /** App ids never counted as screen time (e.g. the "Time's up" dev channel). */
    excludeAppIds: z.array(z.string()).default(['dev']),
  })
  .strict();

export const DatabaseConfigSchema = z
  .object({
    /** Relative paths resolve against the directory containing config.json. */
    path: z.string().min(1).default('data/roku-guardian.db'),
  })
  .strict();

export const LogConfigSchema = z
  .object({
    level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    /** Log file (JSON lines). Relative to config dir. Set to null to disable file logging. */
    file: z.string().min(1).nullable().default('logs/roku-guardian.log'),
    /** Pretty console output. Defaults to true when stdout is a TTY. */
    pretty: z.boolean().optional(),
    /** The log file starts afresh each day; older days are kept as roku-guardian.YYYY-MM-DD.log. */
    keepDays: z.number().int().min(1).max(365).default(14),
    /** Also start a new file when the current one passes this size. */
    maxSizeMb: z.number().min(1).max(1024).default(20),
  })
  .strict();

export const HttpConfigSchema = z
  .object({
    /** Serve the dashboard + API. */
    enabled: z.boolean().default(true),
    /**
     * Bind address. 0.0.0.0 so it survives the PC's DHCP address changing; access is limited to
     * LAN clients by `lanOnly` and the Windows Firewall rule (README).
     */
    host: z.string().default('0.0.0.0'),
    port: port.default(8090),
    /** Reject requests from non-private IP addresses (403). */
    lanOnly: z.boolean().default(true),
    /** How long a dashboard login lasts. */
    sessionDays: z.number().min(1).max(365).default(30),
  })
  .strict();

export const NotificationsConfigSchema = z
  .object({
    ntfy: z
      .object({
        enabled: z.boolean().default(false),
        server: z.url().default('https://ntfy.sh'),
        /** Topic name. Public ntfy.sh topics are readable by anyone who knows the name: make it long and random. */
        topic: z.string().trim().default(''),
      })
      .strict()
      .prefault({}),
    events: z
      .object({
        blockedApp: z.boolean().default(true),
        budgetExhausted: z.boolean().default(true),
        /** TV switched on during quiet hours / outside viewing hours. */
        scheduleViolation: z.boolean().default(true),
        unreachable: z.boolean().default(true),
        /** ECP restricted/disabled on the TV — possible tampering. */
        restricted: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
    /** Only report "TV unreachable" after this long (a TV without Fast TV start drops off when turned off). */
    unreachableAfterMin: z
      .number()
      .min(1)
      .max(24 * 60)
      .default(30),
    /** Also notify for dry-run actions ("would send Home"). */
    includeDryRun: z.boolean().default(false),
  })
  .strict();

export type NotificationsConfig = z.output<typeof NotificationsConfigSchema>;

/**
 * The words on the TV, per message and field (see src/enforce/message-catalog.ts for the keys,
 * fields and fill-ins). Only changed fields are kept; leaving one out means the default.
 */
export const TvTextsSchema = z
  .partialRecord(z.enum(MESSAGE_KEYS), z.record(z.string(), z.string()))
  .superRefine((texts, ctx) => {
    for (const [key, fields] of Object.entries(texts) as Array<[MessageKey, Record<string, string>]>) {
      const entry = CATALOG_BY_KEY[key];
      for (const [id, raw] of Object.entries(fields)) {
        const field = entry.fields.find((f) => f.id === id);
        if (!field) {
          ctx.addIssue({
            code: 'custom',
            path: [key, id],
            message: `Unknown field "${id}" (use ${entry.fields.map((f) => f.id).join(' or ')})`,
          });
          continue;
        }
        for (const message of textProblems(entry, field, raw))
          ctx.addIssue({ code: 'custom', path: [key, id], message });
      }
    }
  })
  .transform((texts) => compactTexts(texts));

/**
 * Before the full editor, the "Screen time's up" tip had its own field (`timesUpTip`, only for a
 * few hours on 2026-10-01). Fold it into the message so an old config or saved setting still loads.
 */
function migrateTimesUpTip(input: unknown): unknown {
  if (!input || typeof input !== 'object' || !('timesUpTip' in input)) return input;
  const { timesUpTip, ...rest } = input as { timesUpTip?: unknown; texts?: TvTexts };
  const texts: TvTexts = { ...(rest.texts ?? {}) };
  if (typeof timesUpTip === 'string' && texts.global_budget?.body === undefined) {
    const firstLine = textFor(undefined, 'global_budget', 'body').split('\n')[0]!;
    const tip = timesUpTip.trim();
    texts.global_budget = { ...texts.global_budget, body: tip ? `${firstLine}\n${tip}` : firstLine };
  }
  return { ...rest, texts };
}

/** Messages on the TV through the sideloaded Parental Control channel (roku-channel/). */
export const TvMessagesConfigSchema = z.preprocess(
  migrateTimesUpTip,
  z
    .object({
      /**
       * Explain each action on the TV when the channel is installed: a message instead of a bare
       * Home press, and a countdown before switching off. Without the channel, Home/PowerOff as before.
       */
      enabled: z.boolean().default(true),
      /** Channel id. A sideloaded developer channel is always "dev". */
      appId: z.string().trim().min(1).default('dev'),
      /** Countdown before switching the TV off for quiet hours or outside viewing hours. 0 = switch off at once. */
      countdownSec: z.number().int().min(0).max(120).default(30),
      /** Shorter countdown for a lock, repeated tries, or the TV switched back on soon after. */
      shortCountdownSec: z.number().int().min(0).max(60).default(10),
      /** Warn this many minutes before screen time or viewing hours run out (interrupts the show). 0 = off. */
      warnBeforeMin: z.number().int().min(0).max(30).default(0),
      /** How long the warning stays up before the show comes back. */
      warningSec: z.number().int().min(3).max(60).default(8),
      /** How long a parent's message stays up before the show comes back (when asked to go back). */
      messageSec: z.number().int().min(5).max(120).default(15),
      /** Rewritten messages; see TvTextsSchema. */
      texts: TvTextsSchema.default({}),
    })
    .strict(),
);

export type TvMessagesConfig = z.output<typeof TvMessagesConfigSchema>;

export const BackupConfigSchema = z
  .object({
    /** Nightly copy of the database (SQLite online backup; safe while the service runs). */
    enabled: z.boolean().default(true),
    /** Relative to the config directory. */
    dir: z.string().min(1).default('data/backups'),
    /** Local time to back up at. A PC that was asleep backs up as soon as it wakes. */
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM, e.g. "03:30"')
      .default('03:30'),
    /** Daily backups to keep. */
    keep: z.number().int().min(1).max(365).default(7),
  })
  .strict();

export const ConfigSchema = z
  .object({
    $schema: z.string().optional(),
    timezone: timezone.default('America/New_York'),
    device: DeviceConfigSchema.prefault({}),
    discovery: DiscoveryConfigSchema.prefault({}),
    monitor: MonitorConfigSchema.prefault({}),
    usage: UsageConfigSchema.prefault({}),
    database: DatabaseConfigSchema.prefault({}),
    log: LogConfigSchema.prefault({}),
    /** Phase 2. Absent = no rules (pure monitoring). See src/config/rules-schema.ts for the format. */
    rules: RulesConfigSchema.prefault({}),
    enforcement: EnforcementConfigSchema.prefault({}),
    /** Phase 3. */
    http: HttpConfigSchema.prefault({}),
    notifications: NotificationsConfigSchema.prefault({}),
    /** Phase 4. */
    tvMessages: TvMessagesConfigSchema.prefault({}),
    backup: BackupConfigSchema.prefault({}),
  })
  .strict();

export type ConfigInput = z.input<typeof ConfigSchema>;
export type ParsedConfig = z.output<typeof ConfigSchema>;

/** Fully-resolved config: absolute paths and derived values filled in. */
export interface Config extends ParsedConfig {
  monitor: ParsedConfig['monitor'] & { maxGapSec: number };
  /** Absolute path of the config file that was loaded (or would have been). */
  configPath: string;
  /** Directory used to resolve relative paths. */
  baseDir: string;
}
