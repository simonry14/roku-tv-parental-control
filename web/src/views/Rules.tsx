import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type ApiError,
  type AppDto,
  type RulesDto,
  type RulesInput,
  type SettingsDto,
  type Weekday,
} from '../api';
import { ScheduleTrack, TrackAxis } from '../components/ScheduleTrack';
import { Banner, Button, Icon, MinutesStepper, Section, Segmented, Switch, useToast } from '../components/ui';
import { localNow, WEEKDAY_NAMES, WEEKDAY_SHORT, windowLabel } from '../format';
import { useApi } from '../hooks';
import { DAYS, quietSegments, splitWindow, viewingSegments } from '../schedule';

type Mode = SettingsDto['enforcement']['mode'];

const MODE_HELP: Record<Mode, string> = {
  off: 'Rules are not checked. Screen time is still recorded.',
  'dry-run':
    'Practice mode: rules are checked and written to History, but the TV is never controlled. Use it to try new rules.',
  enforce: 'Blocked apps go back to Home, and the TV turns off during quiet hours and outside viewing hours.',
};

export function RulesView() {
  const toast = useToast();
  const rules = useApi<RulesDto>('/api/rules');
  const apps = useApi<AppDto[]>('/api/apps');
  const settings = useApi<SettingsDto>('/api/settings');
  const [draft, setDraft] = useState<RulesInput | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [editing, setEditing] = useState<Weekday | null>(null);

  useEffect(() => {
    if (rules.data) setDraft(structuredClone(rules.data.rules));
  }, [rules.data]);

  const dirty = useMemo(
    () => draft !== null && rules.data !== null && JSON.stringify(draft) !== JSON.stringify(rules.data.rules),
    [draft, rules.data],
  );

  if (!draft || !rules.data) return <p className="py-24 text-center text-muted">Loading…</p>;

  const update = (fn: (r: RulesInput) => void): void => {
    setDraft((d) => {
      const next = structuredClone(d!);
      fn(next);
      return next;
    });
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const saved = await api.put<RulesDto>('/api/rules', { rules: draft });
      rules.setData(saved);
      void apps.reload();
      toast('Rules saved');
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setSaving(false);
    }
  };

  const useFile = async (): Promise<void> => {
    if (!window.confirm('Go back to the rules from setup? The changes made here in the dashboard are dropped.')) return;
    const r = await api.del<RulesDto>('/api/rules');
    rules.setData(r);
    toast('Back to the rules from setup');
  };

  const setMode = async (mode: Mode): Promise<void> => {
    if (!settings.data) return;
    try {
      const s = await api.put<SettingsDto>('/api/settings/enforcement', { ...settings.data.enforcement, mode });
      settings.setData(s);
      toast(
        mode === 'enforce'
          ? 'Rules are now enforced'
          : mode === 'dry-run'
            ? 'Practice mode: rules are checked, not enforced'
            : 'Rules are off',
      );
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const { day: today, minute: nowMin } = localNow(settings.data?.timezone ?? 'America/New_York');

  return (
    <div className="pb-28">
      <h1 className="mb-1 text-3xl font-semibold tracking-tight">Rules</h1>
      <p className="mb-4 text-[15px] text-muted">
        {rules.data.source === 'dashboard' ? (
          <>
            Changed here in the dashboard.{' '}
            <button type="button" onClick={useFile} className="text-accent underline underline-offset-2">
              Go back to the rules from setup
            </button>
          </>
        ) : (
          'The rules from setup (config.json on the PC). Changes you save here take over from them.'
        )}
      </p>

      {settings.data && (
        <Section title="What happens when a rule is broken">
          <Segmented<Mode>
            label="Enforcement mode"
            value={settings.data.enforcement.mode}
            onChange={setMode}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'dry-run', label: 'Practice' },
              { value: 'enforce', label: 'Enforce' },
            ]}
          />
          <p className="mt-2 text-sm text-muted">{MODE_HELP[settings.data.enforcement.mode]}</p>
        </Section>
      )}

      <Section
        title="Daily screen time"
        description="Time in apps and TV inputs. The Home screen and screensaver don’t count."
      >
        {(['weekday', 'weekend'] as const).map((k) => (
          <div key={k} className="flex min-h-14 items-center justify-between gap-3">
            <span className="text-[15px]">
              {k === 'weekday'
                ? 'School days'
                : `Weekends (${draft.weekendDays.map((d) => WEEKDAY_SHORT[d]).join(', ')})`}
            </span>
            <MinutesStepper
              label={`${k} limit`}
              value={draft.globalBudget[k]}
              allowNone
              min={15}
              onChange={(v) => update((r) => void (r.globalBudget[k] = v))}
            />
          </div>
        ))}
      </Section>

      <Section
        title="Viewing hours"
        description="Outside these hours the TV is switched off."
        action={
          <Switch
            label={<span className="sr-only">Limit viewing hours</span>}
            checked={draft.viewingWindows !== null}
            onChange={(on) =>
              update((r) => {
                r.viewingWindows = on
                  ? {
                      mon: ['15:30-19:30'],
                      tue: ['15:30-19:30'],
                      wed: ['15:30-19:30'],
                      thu: ['15:30-19:30'],
                      fri: ['15:30-19:30'],
                      sat: ['08:00-20:00'],
                      sun: ['08:00-20:00'],
                    }
                  : null;
              })
            }
          />
        }
      >
        <ul className="space-y-1">
          {DAYS.map((d) => {
            const windows = draft.viewingWindows?.[d] ?? null;
            const summary =
              draft.viewingWindows === null || windows === null
                ? 'Any time'
                : windows.length === 0
                  ? 'No TV'
                  : windows.map(windowLabel).join(', ');
            return (
              <li key={d}>
                <button
                  type="button"
                  onClick={() => setEditing(editing === d ? null : d)}
                  aria-expanded={editing === d}
                  disabled={draft.viewingWindows === null}
                  className="w-full rounded-xl px-2 py-2 text-left hover:bg-raised disabled:hover:bg-transparent"
                >
                  <div className="mb-1.5 flex items-baseline justify-between gap-3">
                    <span className="text-[15px] font-medium">{WEEKDAY_NAMES[d]}</span>
                    <span className="text-sm text-muted">{summary}</span>
                  </div>
                  <ScheduleTrack
                    label={`${WEEKDAY_NAMES[d]}: ${summary}`}
                    viewing={viewingSegments(draft, d)}
                    quiet={quietSegments(draft, d)}
                    nowMin={d === today ? nowMin : null}
                  />
                </button>
                {editing === d && draft.viewingWindows && <DayEditor day={d} draft={draft} update={update} />}
              </li>
            );
          })}
        </ul>
        <div className="px-2">
          <TrackAxis />
          <p className="mt-3 flex items-center gap-4 text-sm text-muted">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-5 rounded-full bg-accent" /> Allowed
            </span>
            <span className="flex items-center gap-1.5">
              <span className="hatch inline-block h-3 w-5 rounded-full text-faint" /> Quiet hours
            </span>
          </p>
        </div>
      </Section>

      <Section title="Quiet hours" description="If the TV is switched on during quiet hours, it’s turned off again.">
        <ul className="space-y-3">
          {draft.quietHours.map((q, i) => {
            const [a, b] = splitWindow(q.window);
            return (
              <li key={i} className="rounded-2xl bg-surface p-3">
                <div className="flex items-center gap-2">
                  <TimeInput
                    label="From"
                    value={a}
                    onChange={(v) => update((r) => void (r.quietHours[i]!.window = `${v}-${b}`))}
                  />
                  <span className="text-muted">to</span>
                  <TimeInput
                    label="Until"
                    value={b}
                    onChange={(v) => update((r) => void (r.quietHours[i]!.window = `${a}-${v}`))}
                  />
                  <button
                    type="button"
                    aria-label="Remove quiet hours"
                    onClick={() => update((r) => void r.quietHours.splice(i, 1))}
                    className="ml-auto grid size-10 place-items-center rounded-full text-muted hover:bg-raised"
                  >
                    <Icon name="x" size={18} />
                  </button>
                </div>
                <DayChips
                  value={q.days ?? null}
                  onChange={(days) =>
                    update((r) => {
                      if (days === null) delete r.quietHours[i]!.days;
                      else r.quietHours[i]!.days = days;
                    })
                  }
                />
              </li>
            );
          })}
        </ul>
        <Button
          variant="ghost"
          icon="plus"
          className="mt-2"
          onClick={() => update((r) => void r.quietHours.push({ window: '20:30-07:00' }))}
        >
          Add quiet hours
        </Button>
      </Section>

      <Section title="Apps and inputs">
        <Segmented
          label="App policy"
          value={draft.appPolicy.mode}
          onChange={(mode) => update((r) => void (r.appPolicy = { mode, apps: [] }))}
          options={[
            { value: 'blocklist', label: 'Block some apps' },
            { value: 'allowlist', label: 'Allow only some' },
          ]}
        />
        <p className="mt-2 mb-2 text-sm text-muted">
          {draft.appPolicy.mode === 'blocklist'
            ? 'Everything is allowed except the apps you switch off. Game consoles and antenna inputs are listed too.'
            : 'Only the apps you switch on can be used. Everything else goes back to Home.'}
        </p>
        {apps.data?.length ? (
          <ul className="divide-y divide-line">
            {apps.data
              .filter((a) => !draft.exemptApps.includes(a.appId))
              .map((a) => {
                const listed = draft.appPolicy.apps.includes(a.appId);
                const allowed = draft.appPolicy.mode === 'blocklist' ? !listed : listed;
                const limit = draft.appBudgets[a.appId] ?? null;
                return (
                  <li key={a.appId} className="py-3">
                    <div className="flex items-center gap-3">
                      <img
                        src={a.iconUrl}
                        alt=""
                        loading="lazy"
                        className={`h-9 w-12 shrink-0 rounded-md object-cover ${allowed ? '' : 'opacity-40 grayscale'}`}
                      />
                      <div className="min-w-0 flex-1">
                        <Switch
                          label={a.name}
                          description={allowed ? (limit !== null ? `Up to ${limit} min a day` : 'Allowed') : 'Blocked'}
                          checked={allowed}
                          onChange={(on) =>
                            update((r) => {
                              const set = new Set(r.appPolicy.apps);
                              const shouldList = r.appPolicy.mode === 'blocklist' ? !on : on;
                              if (shouldList) set.add(a.appId);
                              else set.delete(a.appId);
                              r.appPolicy.apps = [...set];
                            })
                          }
                        />
                      </div>
                    </div>
                    {allowed && (
                      <div className="mt-1 flex items-center justify-between gap-3 pl-15">
                        <span className="text-sm text-muted">Daily limit</span>
                        <MinutesStepper
                          label={`${a.name} daily limit`}
                          value={limit}
                          allowNone
                          min={15}
                          onChange={(v) =>
                            update((r) => {
                              if (v === null) delete r.appBudgets[a.appId];
                              else r.appBudgets[a.appId] = v;
                            })
                          }
                        />
                      </div>
                    )}
                  </li>
                );
              })}
          </ul>
        ) : (
          <p className="text-[15px] text-muted">
            The app list appears once Roku TV Parental Control has connected to the TV.
          </p>
        )}
      </Section>

      {(dirty || error) && (
        <div className="fixed inset-x-0 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-40 px-4">
          <div className="mx-auto max-w-xl space-y-2 rounded-3xl bg-surface p-3 shadow-[0_10px_40px_-10px_rgba(10,14,40,.5)]">
            {error && (
              <Banner tone="critical" icon="warning">
                <p className="font-medium">{error.message}</p>
                {error.details && <pre className="mt-1 text-sm whitespace-pre-wrap text-muted">{error.details}</pre>}
              </Banner>
            )}
            <div className="flex gap-2">
              <Button variant="primary" className="flex-1" busy={saving} onClick={save}>
                Save rules
              </Button>
              <Button
                onClick={() => {
                  setDraft(structuredClone(rules.data!.rules));
                  setError(null);
                }}
              >
                Discard
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DayEditor({
  day,
  draft,
  update,
}: {
  day: Weekday;
  draft: RulesInput;
  update: (fn: (r: RulesInput) => void) => void;
}) {
  const windows = draft.viewingWindows![day];
  const mode = windows === null ? 'any' : windows.length === 0 ? 'none' : 'hours';
  const set = (fn: (w: string[] | null) => string[] | null): void =>
    update((r) => void (r.viewingWindows![day] = fn(r.viewingWindows![day] ?? null)));
  const copyTo = (targets: Weekday[]): void =>
    update((r) => {
      for (const t of targets) r.viewingWindows![t] = windows === null ? null : [...windows];
    });

  return (
    <div className="mx-2 mt-1 mb-3 space-y-3 rounded-2xl bg-surface p-3">
      <Segmented
        label={`${WEEKDAY_NAMES[day]} viewing`}
        value={mode}
        onChange={(m) => set(() => (m === 'any' ? null : m === 'none' ? [] : ['15:30-19:30']))}
        options={[
          { value: 'any', label: 'Any time' },
          { value: 'hours', label: 'Set hours' },
          { value: 'none', label: 'No TV' },
        ]}
      />
      {mode === 'hours' &&
        windows!.map((w, i) => {
          const [a, b] = splitWindow(w);
          return (
            <div key={i} className="flex items-center gap-2">
              <TimeInput
                label="From"
                value={a}
                onChange={(v) => set((ws) => ws!.map((x, j) => (j === i ? `${v}-${b}` : x)))}
              />
              <span className="text-muted">to</span>
              <TimeInput
                label="Until"
                value={b}
                onChange={(v) => set((ws) => ws!.map((x, j) => (j === i ? `${a}-${v}` : x)))}
              />
              <button
                type="button"
                aria-label="Remove hours"
                onClick={() => set((ws) => ws!.filter((_, j) => j !== i))}
                className="ml-auto grid size-10 place-items-center rounded-full text-muted hover:bg-raised"
              >
                <Icon name="x" size={18} />
              </button>
            </div>
          );
        })}
      <div className="flex flex-wrap gap-2">
        {mode === 'hours' && (
          <Button variant="ghost" icon="plus" onClick={() => set((ws) => [...(ws ?? []), '18:00-20:00'])}>
            Add hours
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={() =>
            copyTo(
              draft.weekendDays.includes(day) ? draft.weekendDays : DAYS.filter((d) => !draft.weekendDays.includes(d)),
            )
          }
        >
          Same for all {draft.weekendDays.includes(day) ? 'weekend days' : 'school days'}
        </Button>
      </div>
    </div>
  );
}

function TimeInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="time"
      aria-label={label}
      value={value}
      step={300}
      onChange={(e) => e.target.value && onChange(e.target.value)}
      className="tabular min-h-11 rounded-xl border border-line bg-bg px-3 text-[15px] focus:border-accent focus:outline-none"
    />
  );
}

function DayChips({ value, onChange }: { value: Weekday[] | null; onChange: (v: Weekday[] | null) => void }) {
  const every = value === null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="Nights it starts">
      <button
        type="button"
        aria-pressed={every}
        onClick={() => onChange(every ? ['sun', 'mon', 'tue', 'wed', 'thu'] : null)}
        className={`min-h-9 rounded-full px-3 text-sm ${every ? 'bg-accent text-accent-ink' : 'bg-raised text-muted'}`}
      >
        Every night
      </button>
      {!every &&
        DAYS.map((d) => {
          const on = value!.includes(d);
          return (
            <button
              key={d}
              type="button"
              aria-pressed={on}
              onClick={() => {
                const next = on ? value!.filter((x) => x !== d) : [...value!, d];
                onChange(next.length ? DAYS.filter((x) => next.includes(x)) : null);
              }}
              className={`min-h-9 min-w-11 rounded-full px-2 text-sm ${on ? 'bg-accent-soft text-text' : 'bg-raised text-faint'}`}
            >
              {WEEKDAY_SHORT[d]}
            </button>
          );
        })}
    </div>
  );
}
