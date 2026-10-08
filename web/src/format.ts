/** Formatting helpers. Times are shown in the service's time zone, not the phone's. */

export function duration(ms: number, opts: { short?: boolean } = {}): string {
  const totalMin = Math.floor(Math.max(0, ms) / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return totalMin === 0 && ms > 0 && ms < 60_000 ? (opts.short ? '<1m' : 'under a minute') : `${m} min`;
  if (opts.short) return m ? `${h}h ${m}m` : `${h}h`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Hero figure parts: { big: "1", unit: "h", big2: "09", unit2: "min" } */
export function durationParts(ms: number): Array<{ value: string; unit: string }> {
  const totalMin = Math.floor(Math.max(0, ms) / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return [{ value: String(m), unit: 'min' }];
  return [
    { value: String(h), unit: 'h' },
    { value: String(m).padStart(2, '0'), unit: 'min' },
  ];
}

export function clock(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(ms);
}

export function dayLabel(ms: number, tz: string, now = Date.now()): string {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const d = fmt.format(ms);
  if (d === fmt.format(now)) return 'Today';
  if (d === fmt.format(now - 86_400_000)) return 'Yesterday';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(
    ms,
  );
}

export function whenLabel(ms: number, tz: string, now = Date.now()): string {
  const day = dayLabel(ms, tz, now);
  return day === 'Today' ? clock(ms, tz) : `${day}, ${clock(ms, tz)}`;
}

/** Weekday and minute-of-day right now in the service's time zone. */
export function localNow(tz: string): { day: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(Date.now());
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  const day = get('weekday').toLowerCase().slice(0, 3) as ReturnType<typeof localNow>['day'];
  return { day, minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

export const WEEKDAY_NAMES: Record<string, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};
export const WEEKDAY_SHORT: Record<string, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

/** "15:30" → "3:30 PM" */
export function clock24to12(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  if (h === 24 || (h === 0 && m === 0 && hhmm === '24:00')) return 'midnight';
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hh}:${String(m).padStart(2, '0')} ${suffix}` : `${hh} ${suffix}`;
}

export function windowLabel(w: string): string {
  const [a, b] = w.split('-') as [string, string];
  if (a === '00:00' && b === '24:00') return 'All day';
  return `${clock24to12(a)} – ${clock24to12(b)}`;
}

export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
}
