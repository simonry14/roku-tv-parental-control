import { z } from 'zod';
import { parseWindow } from '../rules/schedule.js';
import { WEEKDAYS, type Rules, type TimeWindow, type Weekday } from '../rules/types.js';

/**
 * config.json "rules" block → normalised `Rules`.
 *
 *   "rules": {
 *     "appPolicy": { "mode": "blocklist", "apps": ["2285"] },
 *     "appBudgets": { "44444": 60 },
 *     "globalBudget": { "weekday": 120, "weekend": 180 },        // or a single number, or null
 *     "viewingWindows": { "weekdays": ["15:30-19:30"], "weekends": ["08:00-20:00"] },
 *     "quietHours": ["20:30-07:00"],                              // or { "window": "…", "days": ["fri"] }
 *     "exemptApps": ["dev"]
 *   }
 *
 * Day keys: mon…sun, "weekdays", "weekends", "daily". A specific day beats a group, and a group
 * beats "daily". A day set to [] means no viewing that day; a day that isn't listed is unrestricted.
 */

const DAY_GROUPS = ['weekdays', 'weekends', 'daily'] as const;
const dayKey = z.enum([...WEEKDAYS, ...DAY_GROUPS]);
type DayKey = z.infer<typeof dayKey>;

const minutes = z.number().int().min(0).max(1440);

const windowString = z.string().transform((s, ctx): TimeWindow => {
  try {
    return parseWindow(s);
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: (err as Error).message });
    return z.NEVER;
  }
});

function expandDays(keys: DayKey[], weekend: Weekday[]): Weekday[] {
  const out = new Set<Weekday>();
  for (const k of keys) {
    if (k === 'daily') WEEKDAYS.forEach((d) => out.add(d));
    else if (k === 'weekends') weekend.forEach((d) => out.add(d));
    else if (k === 'weekdays') WEEKDAYS.filter((d) => !weekend.includes(d)).forEach((d) => out.add(d));
    else out.add(k);
  }
  return WEEKDAYS.filter((d) => out.has(d));
}

const viewingWindowsInput = z
  .object(
    Object.fromEntries(dayKey.options.map((k) => [k, z.array(windowString).nullable().optional()])) as {
      [K in DayKey]: z.ZodOptional<z.ZodNullable<z.ZodArray<typeof windowString>>>;
    },
  )
  .strict();

/** "20:30-07:00" or { "window": "20:30-07:00", "days": ["fri", "sat"] } (days = the day it starts). */
const quietEntry = z.preprocess(
  (v) => (typeof v === 'string' ? { window: v } : v),
  z.object({ window: windowString, days: z.array(dayKey).min(1).optional() }).strict(),
);

const globalBudgetInput = z.union([
  minutes.transform((m) => ({ weekday: m, weekend: m })),
  z.null().transform(() => ({ weekday: null, weekend: null })),
  z.object({ weekday: minutes.nullable().default(null), weekend: minutes.nullable().default(null) }).strict(),
]);

export const RulesConfigSchema = z
  .object({
    appPolicy: z
      .object({
        mode: z.enum(['blocklist', 'allowlist']).default('blocklist'),
        apps: z.array(z.string().trim().min(1)).default([]),
      })
      .strict()
      .prefault({}),
    exemptApps: z.array(z.string().trim().min(1)).default(['dev']),
    appBudgets: z.record(z.string().trim().min(1), minutes).default({}),
    globalBudget: globalBudgetInput.default({ weekday: null, weekend: null }),
    weekendDays: z.array(z.enum(WEEKDAYS)).default(['sat', 'sun']),
    viewingWindows: viewingWindowsInput.nullable().default(null),
    quietHours: z.array(quietEntry).default([]),
  })
  .strict()
  .transform((r): Rules => {
    let viewingWindows: Rules['viewingWindows'] = null;
    if (r.viewingWindows) {
      viewingWindows = {};
      // Resolution order: daily < group < specific day.
      const order: DayKey[] = ['daily', 'weekdays', 'weekends', ...WEEKDAYS];
      for (const key of order) {
        const value = r.viewingWindows[key];
        if (value === undefined) continue;
        for (const d of expandDays([key], r.weekendDays)) viewingWindows[d] = value;
      }
    }
    return {
      appPolicy: r.appPolicy,
      exemptApps: r.exemptApps,
      appBudgets: r.appBudgets,
      globalBudget: r.globalBudget,
      weekendDays: r.weekendDays,
      viewingWindows,
      quietHours: r.quietHours.map((q) => ({
        ...q.window,
        ...(q.days ? { days: expandDays(q.days, r.weekendDays) } : {}),
      })),
    };
  });

export const EnforcementConfigSchema = z
  .object({
    /**
     * off      evaluate only (status shows decisions), never act, never log actions
     * dry-run  log what would be done (events table, "Practice mode: …") without touching the TV — default
     * enforce  send Home / PowerOff
     */
    mode: z.enum(['off', 'dry-run', 'enforce']).default('dry-run'),
    /** Minimum gap between two Home presses. */
    cooldownSec: z.number().min(1).max(600).default(10),
    /** Minimum gap between two PowerOff presses. */
    powerOffCooldownSec: z.number().min(1).max(600).default(15),
    /** N app-rule violations (Home presses) within M minutes → PowerOff instead. repeats 0 = never. */
    escalation: z
      .object({
        repeats: z.number().int().min(0).max(50).default(3),
        windowMin: z.number().min(1).max(240).default(5),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type EnforcementConfig = z.output<typeof EnforcementConfigSchema>;
