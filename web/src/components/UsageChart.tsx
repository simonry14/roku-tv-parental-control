import { useMemo, useState } from 'react';
import type { DayUsageDto } from '../api';
import { duration, WEEKDAY_SHORT } from '../format';

/**
 * Screen time per day for the last week, stacked by app. Categorical colours are the validated
 * dataviz slots in fixed order; the top five apps of the week get slots 1–5 and everything else
 * folds into "Other" (never a generated sixth hue). Identity is carried by the legend and the
 * table below the chart, never colour alone. Tap or hover a day for its breakdown.
 */
const SLOTS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)'];
const OTHER = { appId: '__other', appName: 'Other', color: 'var(--series-other)' };

export function UsageChart({ days }: { days: DayUsageDto[] }) {
  const [active, setActive] = useState<number | null>(null);

  const { series, stacks, maxMs } = useMemo(() => {
    const totals = new Map<string, { appName: string; ms: number }>();
    for (const d of days)
      for (const a of d.byApp) totals.set(a.appId, { appName: a.appName, ms: (totals.get(a.appId)?.ms ?? 0) + a.ms });
    const top = [...totals.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 5);
    const series = top.map(([appId, v], i) => ({ appId, appName: v.appName, color: SLOTS[i]! }));
    const hasOther = totals.size > 5;
    if (hasOther) series.push(OTHER);
    const topIds = new Set(top.map(([id]) => id));
    const stacks = days.map((d) =>
      series.map((s) => ({
        ...s,
        ms:
          s.appId === OTHER.appId
            ? d.byApp.filter((a) => !topIds.has(a.appId)).reduce((n, a) => n + a.ms, 0)
            : (d.byApp.find((a) => a.appId === s.appId)?.ms ?? 0),
      })),
    );
    const maxMs = Math.max(...days.map((d) => d.screenMs), 60 * 60_000);
    return { series, stacks, maxMs };
  }, [days]);

  // Clean hour ticks: 0, 1h, 2h… (or 30-min steps for light weeks)
  const stepMs = maxMs <= 2 * 3_600_000 ? 30 * 60_000 : maxMs <= 6 * 3_600_000 ? 3_600_000 : 2 * 3_600_000;
  const top = Math.ceil(maxMs / stepMs) * stepMs;
  const ticks = Array.from({ length: top / stepMs + 1 }, (_, i) => i * stepMs);
  const H = 180;

  return (
    <figure className="m-0">
      <div className="relative pl-10" onMouseLeave={() => setActive(null)}>
        {/* grid + ticks */}
        <div className="absolute inset-y-0 left-0 right-0" aria-hidden="true" style={{ height: H }}>
          {ticks.map((t) => (
            <div
              key={t}
              className="absolute right-0 left-10 border-t border-line"
              style={{ bottom: `${(t / top) * 100}%` }}
            >
              <span className="tabular absolute -top-2.5 -left-10 w-8 text-right text-xs text-faint">
                {t === 0 ? '0' : duration(t, { short: true })}
              </span>
            </div>
          ))}
        </div>
        <div className="relative grid grid-cols-7" style={{ height: H }}>
          {stacks.map((segs, i) => {
            const d = days[i]!;
            const isActive = active === i;
            return (
              <button
                key={d.day}
                type="button"
                aria-label={`${WEEKDAY_SHORT[d.weekday]}: ${duration(d.screenMs)}`}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onClick={() => setActive(isActive ? null : i)}
                className="group relative flex h-full flex-col-reverse items-center rounded-lg focus-visible:outline-offset-0"
              >
                <span
                  className={`absolute inset-x-1 inset-y-0 rounded-lg ${isActive ? 'bg-raised' : ''}`}
                  aria-hidden="true"
                />
                <span
                  className="relative flex w-full max-w-6 flex-col-reverse gap-[2px]"
                  style={{ height: `${(d.screenMs / top) * 100}%` }}
                >
                  {segs
                    .filter((s) => s.ms > 0)
                    .map((s, j, arr) => (
                      <span
                        key={s.appId}
                        className={j === arr.length - 1 ? 'rounded-t-[4px]' : ''}
                        style={{ background: s.color, flexGrow: s.ms, flexBasis: 0, minHeight: 2 }}
                      />
                    ))}
                </span>
              </button>
            );
          })}
        </div>
        <div className="grid grid-cols-7 pt-2 text-center text-xs text-muted" aria-hidden="true">
          {days.map((d, i) => (
            <span key={d.day} className={i === days.length - 1 ? 'font-semibold text-text' : ''}>
              {i === days.length - 1 ? 'Today' : WEEKDAY_SHORT[d.weekday]}
            </span>
          ))}
        </div>

        {active !== null && (
          <div
            role="status"
            className="pointer-events-none absolute top-0 z-10 w-48 rounded-2xl bg-text p-3 text-bg shadow-lg"
            style={{ left: `clamp(0px, calc(2.5rem + ${((active + 0.5) / 7) * 100}% - 6rem), calc(100% - 12rem))` }}
          >
            <p className="mb-1 text-sm font-semibold">
              {active === days.length - 1 ? 'Today' : WEEKDAY_SHORT[days[active]!.weekday]}:{' '}
              {duration(days[active]!.screenMs)}
            </p>
            <ul className="space-y-0.5 text-sm">
              {stacks[active]!.filter((s) => s.ms > 0).map((s) => (
                <li key={s.appId} className="flex items-center gap-2">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
                  <span className="flex-1 truncate">{s.appName}</span>
                  <span className="tabular">{duration(s.ms, { short: true })}</span>
                </li>
              ))}
              {days[active]!.screenMs === 0 && <li className="opacity-70">No screen time</li>}
            </ul>
          </div>
        )}
      </div>

      {series.length > 1 && (
        <figcaption className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 text-sm text-muted">
          {series.map((s) => (
            <span key={s.appId} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-full" style={{ background: s.color }} aria-hidden="true" />
              {s.appName}
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}
