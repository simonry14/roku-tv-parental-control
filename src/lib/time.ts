import { DateTime } from 'luxon';

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** A half-open UTC interval [start, end) in epoch milliseconds, labelled with its local day. */
export interface DayRange {
  /** Local calendar date, yyyy-MM-dd. */
  day: string;
  start: number;
  end: number;
}

/**
 * The local calendar day containing `atMs` in `zone`. Uses Luxon so DST days are correctly
 * 23 or 25 hours long — never compute day boundaries as `start + 86_400_000`.
 */
export function localDayRange(atMs: number, zone: string): DayRange {
  const start = DateTime.fromMillis(atMs, { zone }).startOf('day');
  return rangeFromStart(start);
}

/** Range for an explicit local date string (yyyy-MM-dd). */
export function dayRangeFor(isoDay: string, zone: string): DayRange {
  const start = DateTime.fromISO(isoDay, { zone }).startOf('day');
  if (!start.isValid) throw new Error(`Invalid day "${isoDay}" (${start.invalidExplanation ?? 'unknown'})`);
  return rangeFromStart(start);
}

function rangeFromStart(start: DateTime): DayRange {
  const end = start.plus({ days: 1 }).startOf('day');
  return { day: start.toISODate()!, start: start.toMillis(), end: end.toMillis() };
}

/** Overlap in ms between [aStart, aEnd) and [bStart, bEnd). */
export function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/** Compact human duration: "1h 05m", "12m 30s", "45s". */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** "3s ago", "4m ago", "2h ago". */
export function formatAgo(fromMs: number, nowMs: number): string {
  const sec = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86_400)}d ago`;
}

export function formatLocal(ms: number, zone: string, format = 'ccc d LLL, h:mm:ss a ZZZZ'): string {
  return DateTime.fromMillis(ms, { zone }).toFormat(format);
}
