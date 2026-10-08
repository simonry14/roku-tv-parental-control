import { DateTime } from 'luxon';
import { WEEKDAYS, type Rules, type ScheduleChange, type TimeWindow, type Weekday } from './types.js';

/**
 * Schedule evaluation on **local wall-clock time** in the configured zone. Comparing wall-clock
 * minutes (not elapsed time since midnight) is what makes DST behave the way a parent expects:
 * "quiet hours until 07:00" ends at 07:00 on the clock, on 23- and 25-hour days alike.
 */

export const MINUTES_PER_DAY = 1440;

export function weekdayOf(local: DateTime): Weekday {
  return WEEKDAYS[local.weekday - 1]!; // Luxon: 1 = Monday … 7 = Sunday
}

export function minuteOfDay(local: DateTime): number {
  return local.hour * 60 + local.minute;
}

/** "HH:MM" (00:00–24:00) → minutes after midnight. */
export function parseClock(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`Invalid time "${s}" (expected HH:MM)`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) throw new Error(`Invalid time "${s}"`);
  return h * 60 + min;
}

/** "15:30-19:30" (also accepts – or —) → TimeWindow. */
export function parseWindow(s: string): TimeWindow {
  const parts = s.split(/\s*[-–—]\s*/);
  if (parts.length !== 2) throw new Error(`Invalid window "${s}" (expected HH:MM-HH:MM)`);
  const start = parseClock(parts[0]!);
  const end = parseClock(parts[1]!);
  if (start === MINUTES_PER_DAY) throw new Error(`Window "${s}" cannot start at 24:00`);
  return { start, end: end === MINUTES_PER_DAY && start === 0 ? 0 : end };
}

export function formatClock(min: number): string {
  const m = ((min % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function formatWindow(w: TimeWindow): string {
  return w.start === w.end ? 'all day' : `${formatClock(w.start)}–${formatClock(w.end)}`;
}

const wraps = (w: TimeWindow): boolean => w.end < w.start;

/** Does a window that starts on `startDay` cover local (day, minute)? */
function covers(w: TimeWindow, startDay: Weekday, today: Weekday, yesterday: Weekday, m: number): boolean {
  if (startDay === today) {
    if (w.start === w.end) return true;
    return wraps(w) ? m >= w.start : m >= w.start && m < w.end;
  }
  if (startDay === yesterday) return wraps(w) && m < w.end;
  return false;
}

function localDays(local: DateTime): { today: Weekday; yesterday: Weekday; m: number } {
  return { today: weekdayOf(local), yesterday: weekdayOf(local.minus({ days: 1 })), m: minuteOfDay(local) };
}

/** The quiet-hours window currently in force, if any. */
export function activeQuietWindow(rules: Rules, local: DateTime): TimeWindow | null {
  const { today, yesterday, m } = localDays(local);
  for (const q of rules.quietHours) {
    const days = q.days ?? WEEKDAYS;
    for (const d of [today, yesterday]) {
      if (days.includes(d) && covers(q, d, today, yesterday, m)) return q;
    }
  }
  return null;
}

/**
 * true/false = inside/outside today's allowed viewing windows; null = today is unrestricted
 * (no windows configured, or none for this weekday). A window that started yesterday and runs
 * past midnight still counts today.
 */
export function inViewingWindow(rules: Rules, local: DateTime): boolean | null {
  const vw = rules.viewingWindows;
  if (!vw) return null;
  const { today, yesterday, m } = localDays(local);
  const todays = vw[today];
  if (todays === undefined || todays === null) return null;
  if (todays.some((w) => covers(w, today, today, yesterday, m))) return true;
  const yesterdays = vw[yesterday] ?? [];
  return yesterdays.some((w) => covers(w, yesterday, today, yesterday, m));
}

/** Viewing windows that apply to a given weekday (for display). */
export function windowsFor(rules: Rules, day: Weekday): TimeWindow[] | null {
  return rules.viewingWindows?.[day] ?? null;
}

export function isWeekend(rules: Rules, local: DateTime): boolean {
  return rules.weekendDays.includes(weekdayOf(local));
}

// ─── Next change ────────────────────────────────────────────────────────────

interface ScheduleState {
  quiet: boolean;
  window: boolean | null;
}

function stateAt(rules: Rules, ms: number, zone: string): ScheduleState {
  const local = DateTime.fromMillis(ms, { zone });
  return { quiet: activeQuietWindow(rules, local) !== null, window: inViewingWindow(rules, local) };
}

/** Local date + minute-of-day → epoch ms. Nonexistent DST-gap times shift forward (Luxon). */
function instant(day: DateTime, minute: number): number {
  if (minute >= MINUTES_PER_DAY) return day.plus({ days: 1 }).startOf('day').toMillis();
  return day
    .startOf('day')
    .set({ hour: Math.floor(minute / 60), minute: minute % 60 })
    .toMillis();
}

/**
 * The next moment the schedule state (quiet hours / viewing window) changes, looking up to a
 * week ahead. Pure; used for "next rule change" on the dashboard and CLI.
 */
export function nextScheduleChange(rules: Rules, now: number, zone: string): ScheduleChange | null {
  const base = DateTime.fromMillis(now, { zone }).startOf('day');
  const candidates = new Set<number>();
  for (let offset = -1; offset <= 8; offset++) {
    const day = base.plus({ days: offset });
    const wd = weekdayOf(day);
    candidates.add(day.toMillis()); // midnight: per-day rules can change
    for (const q of rules.quietHours) {
      if (q.days && !q.days.includes(wd)) continue;
      candidates.add(instant(day, q.start));
      candidates.add(instant(wraps(q) ? day.plus({ days: 1 }) : day, q.start === q.end ? MINUTES_PER_DAY : q.end));
    }
    for (const w of windowsFor(rules, wd) ?? []) {
      candidates.add(instant(day, w.start));
      candidates.add(instant(wraps(w) ? day.plus({ days: 1 }) : day, w.start === w.end ? MINUTES_PER_DAY : w.end));
    }
  }

  const current = stateAt(rules, now, zone);
  for (const at of [...candidates].filter((t) => t > now).sort((a, b) => a - b)) {
    const next = stateAt(rules, at, zone);
    if (next.quiet !== current.quiet) return { at, label: next.quiet ? 'Quiet hours start' : 'Quiet hours end' };
    const allowedNow = current.window !== false;
    const allowedNext = next.window !== false;
    if (allowedNow !== allowedNext)
      return { at, label: allowedNext ? 'Viewing window opens' : 'Viewing window closes' };
  }
  return null;
}

/** Viewing is allowed by the schedule alone (not in quiet hours, not outside a viewing window). */
export function scheduleAllows(rules: Rules, ms: number, zone: string): boolean {
  const s = stateAt(rules, ms, zone);
  return !s.quiet && s.window !== false;
}

/** The next moment the schedule allows viewing (now, if it does already); null if not within a week. */
export function nextAllowedAt(rules: Rules, now: number, zone: string): number | null {
  if (scheduleAllows(rules, now, zone)) return now;
  let t = now;
  for (let i = 0; i < 64; i++) {
    const change = nextScheduleChange(rules, t, zone);
    if (!change) return null;
    if (scheduleAllows(rules, change.at, zone)) return change.at;
    t = change.at;
  }
  return null;
}

/** When the time the schedule allows right now runs out (quiet hours start / window closes); null if it doesn't. */
export function allowedUntil(rules: Rules, now: number, zone: string): number | null {
  if (!scheduleAllows(rules, now, zone)) return null;
  return nextScheduleChange(rules, now, zone)?.at ?? null;
}
