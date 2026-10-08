/**
 * Rules-engine types. These are the *normalised* forms the engine consumes; config.json uses a
 * friendlier shape ("15:30-19:30", "weekdays") that src/config/schema.ts parses into these.
 */

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/**
 * A local wall-clock interval, in minutes after midnight: [start, end).
 *   end > start   same-day window (e.g. 15:30–19:30 → 930..1170)
 *   end < start   wraps past midnight; the part after midnight belongs to the start day
 *   end = start   the whole 24 hours
 */
export interface TimeWindow {
  start: number;
  end: number;
}

export interface Rules {
  /**
   * blocklist: listed apps are blocked, everything else allowed.
   * allowlist: only listed apps are allowed (TV inputs like tvinput.hdmi1 count as apps).
   */
  appPolicy: { mode: 'blocklist' | 'allowlist'; apps: string[] };
  /** Apps never blocked or budgeted (e.g. the "Time's up" dev channel). Schedules still apply. */
  exemptApps: string[];
  /** Per-app daily budgets in minutes, keyed by app id. */
  appBudgets: Record<string, number>;
  /** Global daily budget in minutes across all apps; null = unlimited. */
  globalBudget: { weekday: number | null; weekend: number | null };
  weekendDays: Weekday[];
  /**
   * Allowed viewing windows per weekday. null = no window restriction at all.
   * Per day: null/absent = unrestricted that day; [] = no viewing that day.
   */
  viewingWindows: Partial<Record<Weekday, TimeWindow[] | null>> | null;
  /** TV is powered off whenever it is on inside these. `days` = days the window starts on (default all). */
  quietHours: Array<TimeWindow & { days?: Weekday[] }>;
}

export const NO_RULES: Rules = {
  appPolicy: { mode: 'blocklist', apps: [] },
  exemptApps: ['dev'],
  appBudgets: {},
  globalBudget: { weekday: null, weekend: null },
  weekendDays: ['sat', 'sun'],
  viewingWindows: null,
  quietHours: [],
};

/** Manual override set by a parent (CLI now, dashboard in Phase 3). */
export interface Override {
  /** pause = "parent is watching", allow everything. lock = keep the TV off. */
  kind: 'pause' | 'lock';
  /** Epoch ms when it expires; null = until cleared. */
  until: number | null;
  setAt: number;
  note: string | null;
}

export type ReasonCode = 'lock' | 'quiet_hours' | 'outside_window' | 'app_blocked' | 'app_budget' | 'global_budget';

export type Action = 'none' | 'home' | 'power_off';

export interface Decision {
  action: Action;
  reason: ReasonCode | null;
  /** Human sentence for logs/dashboard: "YouTube is blocked", "Quiet hours (20:30–07:00)". */
  message: string;
  /** A pause override is suppressing enforcement. */
  paused: boolean;
  appId: string | null;
  appName: string | null;
  /** Remaining budget for today; null = unlimited / not applicable. Includes bonus time. */
  remainingMs: { global: number | null; app: number | null };
  schedule: {
    inQuietHours: boolean;
    /** null when no viewing windows are configured for today. */
    inViewingWindow: boolean | null;
  };
}

export interface ScheduleChange {
  at: number;
  label: string;
}

/**
 * The editable ("input") form of the rules: what config.json and the dashboard use, with every
 * day spelled out. `RulesConfigSchema.parse(toRulesInput(r))` round-trips to `r`.
 */
export interface RulesInput {
  appPolicy: { mode: 'blocklist' | 'allowlist'; apps: string[] };
  exemptApps: string[];
  appBudgets: Record<string, number>;
  globalBudget: { weekday: number | null; weekend: number | null };
  weekendDays: Weekday[];
  /** null = no window restriction; per day: null = unrestricted, [] = no TV. */
  viewingWindows: Record<Weekday, string[] | null> | null;
  quietHours: Array<{ window: string; days?: Weekday[] }>;
}
