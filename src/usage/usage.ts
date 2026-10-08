import type { SessionKind, SessionsRepo } from '../db/repo.js';
import { localDayRange, overlapMs, type DayRange } from '../lib/time.js';

export interface UsageSpan {
  kind: SessionKind;
  appId: string | null;
  appName: string | null;
  startedAt: number;
  /** ended_at, or last_seen_at for the open session. */
  endAt: number;
}

export interface AppUsage {
  appId: string;
  appName: string;
  ms: number;
}

export interface UsageSummary {
  range: { start: number; end: number; day?: string };
  /** Screen time: kind=app, excluding `excludeAppIds`. This is what budgets count. */
  screenMs: number;
  homeMs: number;
  screensaverMs: number;
  /** Per-app screen time, largest first. */
  byApp: AppUsage[];
}

/**
 * Sum usage inside [range.start, range.end), clipping sessions that straddle the boundaries —
 * so a 23:30–00:30 session gives 30 min to each day. Pure.
 */
export function summarizeUsage(
  spans: UsageSpan[],
  range: { start: number; end: number; day?: string },
  opts: { excludeAppIds?: Iterable<string> } = {},
): UsageSummary {
  const excluded = new Set(opts.excludeAppIds ?? []);
  const byApp = new Map<string, AppUsage>();
  let screenMs = 0;
  let homeMs = 0;
  let screensaverMs = 0;

  for (const s of spans) {
    const ms = overlapMs(s.startedAt, s.endAt, range.start, range.end);
    if (ms <= 0) continue;
    if (s.kind === 'home') homeMs += ms;
    else if (s.kind === 'screensaver') screensaverMs += ms;
    else if (s.appId && !excluded.has(s.appId)) {
      screenMs += ms;
      const entry = byApp.get(s.appId) ?? { appId: s.appId, appName: s.appName ?? s.appId, ms: 0 };
      entry.ms += ms;
      if (s.appName) entry.appName = s.appName; // latest name wins
      byApp.set(s.appId, entry);
    }
  }
  return {
    range,
    screenMs,
    homeMs,
    screensaverMs,
    byApp: [...byApp.values()].sort((a, b) => b.ms - a.ms || a.appName.localeCompare(b.appName)),
  };
}

export class UsageService {
  constructor(
    private readonly sessions: SessionsRepo,
    private readonly zone: string,
    private readonly excludeAppIds: string[],
  ) {}

  forRange(range: { start: number; end: number; day?: string }): UsageSummary {
    const spans: UsageSpan[] = this.sessions.listOverlapping(range.start, range.end).map((s) => ({
      kind: s.kind,
      appId: s.appId,
      appName: s.appName,
      startedAt: s.startedAt,
      endAt: s.endedAt ?? s.lastSeenAt,
    }));
    return summarizeUsage(spans, range, { excludeAppIds: this.excludeAppIds });
  }

  /** Usage for the local day containing `atMs` (budgets reset at local midnight). */
  forDay(atMs: number): UsageSummary & { range: DayRange } {
    const range = localDayRange(atMs, this.zone);
    return this.forRange(range) as UsageSummary & { range: DayRange };
  }
}
