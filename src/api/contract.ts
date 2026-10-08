/**
 * HTTP API contract shared by the server (src/api) and the dashboard (web/). Types only, and it
 * only imports from pure modules, so the web build can import it without pulling in Node code.
 * All timestamps are epoch ms; durations are ms unless the name says otherwise.
 */
import type { MessageKey, TvTexts } from '../enforce/message-catalog.js';
import type { Action, ReasonCode, RulesInput, Weekday } from '../rules/types.js';

export type { RulesInput, Weekday };

export type HealthState = 'starting' | 'searching' | 'online' | 'tv_off' | 'offline' | 'restricted';
export type RestrictionKind = 'limited' | 'blocked' | 'disabled';
export type EnforcementMode = 'off' | 'dry-run' | 'enforce';
export type ActivityKind = 'app' | 'home' | 'screensaver';

export interface AuthStateDto {
  pinSet: boolean;
  authenticated: boolean;
  lockedUntil: number | null;
}

export interface AppUsageDto {
  appId: string;
  appName: string;
  ms: number;
  /** Today's limit including bonus; null = no per-app limit. */
  budgetMs: number | null;
  remainingMs: number | null;
  iconUrl: string;
}

export interface StatusDto {
  now: number;
  timezone: string;
  version: string;
  health: {
    state: HealthState;
    restriction: RestrictionKind | null;
    message: string;
    since: number;
    lastError: string | null;
    lastPollAt: number | null;
  };
  tv: { serial: string; name: string; model: string | null; host: string; port: number; power: string | null } | null;
  current: { kind: ActivityKind; appId: string | null; appName: string; since: number; iconUrl: string | null } | null;
  today: {
    day: string;
    screenMs: number;
    homeMs: number;
    /** Today's global limit including bonus; null = unlimited. */
    budgetMs: number | null;
    remainingMs: number | null;
    bonusMinutes: number;
    byApp: AppUsageDto[];
  };
  decision: { action: Action; reason: ReasonCode | null; message: string; paused: boolean } | null;
  enforcement: { mode: EnforcementMode };
  override: { kind: 'pause' | 'lock'; until: number | null; setAt: number; message: string } | null;
  schedule: { inQuietHours: boolean; inViewingWindow: boolean | null };
  nextChange: { at: number; label: string } | null;
  lastEnforcement: { at: number; message: string } | null;
  /** The Parental Control channel ("Time's up" messages on the TV). */
  tvMessages: {
    enabled: boolean;
    installed: boolean;
    /** The channel is on screen right now. */
    showing: boolean;
    /** A PowerOff is counting down on the TV. */
    countdown: { endsAt: number; title: string; reason: ReasonCode } | null;
  };
}

export interface AppDto {
  appId: string;
  name: string;
  type: string | null;
  iconUrl: string;
  /** How the current rules treat it. */
  rule: 'allowed' | 'blocked' | 'exempt';
  budgetMinutes: number | null;
  todayMs: number;
}

export interface RulesDto {
  rules: RulesInput;
  source: 'config.json' | 'dashboard';
}

export interface DayUsageDto {
  day: string;
  weekday: Weekday;
  screenMs: number;
  homeMs: number;
  byApp: Array<{ appId: string; appName: string; ms: number }>;
}

export interface EventDto {
  id: number;
  at: number;
  type: string;
  severity: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

export interface TvMessagesSettingsDto {
  enabled: boolean;
  appId: string;
  countdownSec: number;
  shortCountdownSec: number;
  warnBeforeMin: number;
  warningSec: number;
  messageSec: number;
  /** Rewritten messages (only the changed fields); see src/enforce/message-catalog.ts. */
  texts: TvTexts;
}

/** POST /api/tv-messages/preview: show one message with example values, using unsaved words. */
export interface TvPreviewRequestDto {
  key: MessageKey;
  texts: TvTexts;
}

export interface SettingsDto {
  version: string;
  timezone: string;
  sources: Record<
    'rules' | 'enforcement' | 'notifications' | 'device' | 'monitor' | 'tvMessages',
    'config.json' | 'dashboard'
  >;
  device: {
    serial: string | null;
    host: string | null;
    port: number;
    pinned: { serial: string; name: string | null; model: string | null; host: string | null; port: number } | null;
  };
  monitor: { pollIntervalSec: number };
  enforcement: {
    mode: EnforcementMode;
    cooldownSec: number;
    powerOffCooldownSec: number;
    escalation: { repeats: number; windowMin: number };
  };
  notifications: {
    ntfy: { enabled: boolean; server: string; topic: string };
    events: {
      blockedApp: boolean;
      budgetExhausted: boolean;
      scheduleViolation: boolean;
      unreachable: boolean;
      restricted: boolean;
    };
    unreachableAfterMin: number;
    includeDryRun: boolean;
    /** NTFY_TOKEN is set in .env (the token itself is never sent to the browser). */
    tokenConfigured: boolean;
  };
  http: { port: number; lanOnly: boolean };
  tvMessages: TvMessagesSettingsDto & {
    /** Installed on the TV (from its channel list), and which version. */
    installed: boolean;
    installedVersion: string | null;
    /** The version in this project's roku-channel/ folder. */
    packageVersion: string | null;
  };
}

export interface ActionResultDto {
  ok: boolean;
  message: string;
}

/** GET /api/phone: the dashboard's address for a phone on the same Wi-Fi, as text and a QR code. */
export interface PhoneLinkDto {
  /** null when this PC has no network address. */
  url: string | null;
  /** An SVG QR code for `url`. */
  qrSvg: string | null;
}

export interface ApiErrorDto {
  error: string;
  details?: string;
}
