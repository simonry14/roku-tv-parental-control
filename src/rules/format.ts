import { formatClock } from './schedule.js';
import { WEEKDAYS, type Rules, type RulesInput, type TimeWindow, type Weekday } from './types.js';

export type { RulesInput } from './types.js';

export function windowToString(w: TimeWindow): string {
  if (w.start === w.end) return '00:00-24:00';
  return `${formatClock(w.start)}-${w.end === 1440 ? '24:00' : formatClock(w.end)}`;
}

/** Normalised `Rules` → the editable form (every day spelled out). Round-trips through RulesConfigSchema. */
export function toRulesInput(rules: Rules): RulesInput {
  let viewingWindows: RulesInput['viewingWindows'] = null;
  if (rules.viewingWindows) {
    viewingWindows = Object.fromEntries(
      WEEKDAYS.map((d) => {
        const ws = rules.viewingWindows?.[d];
        return [d, ws == null ? null : ws.map(windowToString)];
      }),
    ) as Record<Weekday, string[] | null>;
  }
  return {
    appPolicy: { mode: rules.appPolicy.mode, apps: [...rules.appPolicy.apps] },
    exemptApps: [...rules.exemptApps],
    appBudgets: { ...rules.appBudgets },
    globalBudget: { ...rules.globalBudget },
    weekendDays: [...rules.weekendDays],
    viewingWindows,
    quietHours: rules.quietHours.map((q) => ({ window: windowToString(q), ...(q.days ? { days: [...q.days] } : {}) })),
  };
}
