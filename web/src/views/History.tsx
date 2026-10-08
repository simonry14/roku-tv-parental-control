import { useMemo, useState } from 'react';
import type { DayUsageDto, EventDto } from '../api';
import { UsageChart } from '../components/UsageChart';
import { Icon, Section, Segmented } from '../components/ui';
import { dayLabel, duration, clock } from '../format';
import { useApi } from '../hooks';

type Filter = 'all' | 'actions' | 'tv' | 'changes';
const FILTER_TYPES: Record<Filter, string[] | null> = {
  all: null,
  actions: ['enforcement', 'message'],
  tv: ['health', 'device'],
  changes: ['override', 'config', 'auth', 'notification', 'service'],
};

export function HistoryView({ tz }: { tz: string }) {
  const usage = useApi<DayUsageDto[]>('/api/usage?days=7');
  const events = useApi<EventDto[]>('/api/events?limit=200');
  const [filter, setFilter] = useState<Filter>('all');

  const totals = useMemo(() => {
    const m = new Map<string, { appName: string; ms: number }>();
    for (const d of usage.data ?? [])
      for (const a of d.byApp) m.set(a.appId, { appName: a.appName, ms: (m.get(a.appId)?.ms ?? 0) + a.ms });
    return [...m.entries()].map(([appId, v]) => ({ appId, ...v })).sort((a, b) => b.ms - a.ms);
  }, [usage.data]);
  const weekMs = totals.reduce((n, a) => n + a.ms, 0);

  const shown = (events.data ?? []).filter((e) => {
    const types = FILTER_TYPES[filter];
    return types ? types.includes(e.type) : true;
  });

  return (
    <div>
      <h1 className="mb-4 text-3xl font-semibold tracking-tight">History</h1>

      <Section
        title="Last 7 days"
        description={usage.data ? `${duration(weekMs)} of screen time in total.` : undefined}
      >
        {usage.data ? <UsageChart days={usage.data} /> : <p className="text-muted">Loading…</p>}
        {totals.length > 0 && (
          <table className="mt-5 w-full text-[15px]">
            <caption className="sr-only">Screen time by app, last 7 days</caption>
            <thead>
              <tr className="text-left text-sm text-muted">
                <th className="py-1 font-normal">App</th>
                <th className="py-1 text-right font-normal">Week</th>
                <th className="py-1 text-right font-normal">Per day</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {totals.map((a) => (
                <tr key={a.appId}>
                  <td className="py-2.5">{a.appName}</td>
                  <td className="tabular py-2.5 text-right">{duration(a.ms, { short: true })}</td>
                  <td className="tabular py-2.5 text-right text-muted">{duration(a.ms / 7, { short: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Activity">
        <Segmented<Filter>
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'actions', label: 'Actions' },
            { value: 'tv', label: 'TV' },
            { value: 'changes', label: 'Changes' },
          ]}
        />
        {shown.length === 0 ? (
          <p className="mt-4 text-[15px] text-muted">Nothing here yet.</p>
        ) : (
          <ol className="mt-3">
            {shown.map((e, i) => {
              const day = dayLabel(e.at, tz);
              const prevDay = i > 0 ? dayLabel(shown[i - 1]!.at, tz) : null;
              return (
                <li key={e.id}>
                  {day !== prevDay && <h3 className="mt-4 mb-1 text-sm font-medium text-muted">{day}</h3>}
                  <div className="flex gap-3 py-2">
                    <span className="tabular w-16 shrink-0 pt-0.5 text-sm text-faint">{clock(e.at, tz)}</span>
                    {e.severity === 'error' || e.severity === 'warn' ? (
                      <Icon
                        name="warning"
                        size={18}
                        className={`mt-0.5 shrink-0 ${e.severity === 'error' ? 'text-critical' : 'text-warning'}`}
                      />
                    ) : (
                      <span className="mt-2 size-1.5 shrink-0 rounded-full bg-faint" aria-hidden="true" />
                    )}
                    <span className="min-w-0 text-[15px]">{e.message.replace(' — ', ': ')}</span>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </Section>
    </div>
  );
}
