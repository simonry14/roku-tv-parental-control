import type { RulesInput, Weekday } from './api';
import { minutesOf } from './format';

export const DAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export interface Segment {
  start: number; // minutes 0..1440
  end: number;
}

const prevDay = (d: Weekday): Weekday => DAYS[(DAYS.indexOf(d) + 6) % 7]!;

/** Split "HH:MM-HH:MM" into today's part and the part that spills past midnight. */
function parts(w: string): { today: Segment; spill: Segment | null } {
  const [a, b] = w.split('-') as [string, string];
  const s = minutesOf(a);
  let e = minutesOf(b);
  if (e === s) return { today: { start: 0, end: 1440 }, spill: null };
  if (e === 0) e = 1440;
  if (e > s) return { today: { start: s, end: e }, spill: null };
  return { today: { start: s, end: 1440 }, spill: { start: 0, end: e } };
}

/** Allowed viewing segments on `day` (null = no restriction that day). */
export function viewingSegments(rules: RulesInput, day: Weekday): Segment[] | null {
  const vw = rules.viewingWindows;
  if (!vw) return null;
  const todays = vw[day];
  if (todays == null) return null;
  const out = todays.map((w) => parts(w).today);
  for (const w of vw[prevDay(day)] ?? []) {
    const spill = parts(w).spill;
    if (spill) out.push(spill);
  }
  return out;
}

export function quietSegments(rules: RulesInput, day: Weekday): Segment[] {
  const out: Segment[] = [];
  for (const q of rules.quietHours) {
    const days = q.days ?? DAYS;
    const p = parts(q.window);
    if (days.includes(day)) out.push(p.today);
    if (p.spill && days.includes(prevDay(day))) out.push(p.spill);
  }
  return out;
}

/** <input type="time"> can't show 24:00; the engine treats an end of 00:00 as midnight anyway. */
export const toInput = (hhmm: string): string => (hhmm === '24:00' ? '00:00' : hhmm);

export function splitWindow(w: string): [string, string] {
  const [a, b] = w.split('-') as [string, string];
  return [toInput(a), toInput(b)];
}
