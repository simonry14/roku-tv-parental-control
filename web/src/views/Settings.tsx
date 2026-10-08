import { useEffect, useState, type ReactNode } from 'react';
import { api, type ActionResultDto, type PhoneLinkDto, type SettingsDto } from '../api';
import { Banner, Button, Icon, MinutesStepper, Section, Switch, TextField, useToast } from '../components/ui';
import { useApi } from '../hooks';
import { changedCount } from '../../../src/enforce/message-catalog';

type Sections = 'device' | 'monitor' | 'enforcement' | 'notifications' | 'tvMessages';

export function SettingsView({
  onSignOut,
  theme,
  setTheme,
}: {
  onSignOut: () => void;
  theme: string;
  setTheme: (t: string) => void;
}) {
  const toast = useToast();
  const s = useApi<SettingsDto>('/api/settings');
  const [draft, setDraft] = useState<SettingsDto | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (s.data) setDraft(structuredClone(s.data));
  }, [s.data]);

  if (!draft || !s.data) return <p className="py-24 text-center text-muted">Loading…</p>;

  const save = async (section: Sections, body: unknown, done: string): Promise<void> => {
    setBusy(section);
    try {
      const next = await api.put<SettingsDto>(`/api/settings/${section}`, body);
      s.setData(next);
      toast(done);
    } catch (err) {
      toast(`${(err as Error).message}`, 'error');
    } finally {
      setBusy(null);
    }
  };
  const reset = async (section: Sections): Promise<void> => {
    const next = await api.del<SettingsDto>(`/api/settings/${section}`);
    s.setData(next);
    toast('Back to the values from setup');
  };
  const sourceNote = (section: Sections): ReactNode =>
    s.data!.sources[section] === 'dashboard' ? (
      <button type="button" className="text-sm text-accent underline underline-offset-2" onClick={() => reset(section)}>
        Use the values from setup
      </button>
    ) : null;
  const changed = (section: Sections): boolean => JSON.stringify(draft[section]) !== JSON.stringify(s.data![section]);

  const n = draft.notifications;
  const setN = (fn: (x: SettingsDto['notifications']) => void): void =>
    setDraft((d) => {
      const next = structuredClone(d!);
      fn(next.notifications);
      return next;
    });

  return (
    <div className="pb-8">
      <h1 className="mb-4 text-3xl font-semibold tracking-tight">Settings</h1>

      <Section title="TV" action={sourceNote('device')}>
        {draft.device.pinned ? (
          <p className="mb-2 text-[15px]">
            {draft.device.pinned.name ?? 'Roku TV'}
            <span className="block text-sm text-muted">
              Serial {draft.device.pinned.serial}, at {draft.device.pinned.host ?? 'unknown address'}
            </span>
          </p>
        ) : (
          <p className="mb-2 text-[15px] text-muted">No TV found yet.</p>
        )}
        <TextField
          label="TV address (optional)"
          value={draft.device.host ?? ''}
          placeholder="Found automatically"
          inputMode="decimal"
          hint="Only needed if the TV isn’t found on its own. A fixed address for the TV in your router is even better."
          onChange={(v) => setDraft((d) => ({ ...d!, device: { ...d!.device, host: v || null } }))}
        />
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={!changed('device')}
            busy={busy === 'device'}
            onClick={() =>
              save('device', { serial: draft.device.serial ?? '', host: draft.device.host ?? '' }, 'TV settings saved')
            }
          >
            Save TV settings
          </Button>
          <Button
            onClick={async () => {
              await api.post<ActionResultDto>('/api/actions/rediscover');
              toast('Looking for the TV');
            }}
          >
            Find the TV again
          </Button>
        </div>
      </Section>

      <PhoneSection />

      <TvMessagesSection
        draft={draft.tvMessages}
        saved={s.data.tvMessages}
        source={sourceNote('tvMessages')}
        busy={busy === 'tvMessages'}
        onChange={(tv) => setDraft((d) => ({ ...d!, tvMessages: tv }))}
        onSave={() => {
          const { installed: _i, installedVersion: _v, packageVersion: _p, ...body } = draft.tvMessages;
          void save('tvMessages', body, 'TV message settings saved');
        }}
        onRefresh={async () => {
          await api.post<ActionResultDto>('/api/tv-messages/refresh');
          toast('Checking the TV’s channels');
          window.setTimeout(() => void s.reload(), 3000);
        }}
        onTest={async () => {
          try {
            toast((await api.post<ActionResultDto>('/api/tv-messages/test')).message);
          } catch (err) {
            toast((err as Error).message, 'error');
          }
        }}
      />

      <Section
        title="Notifications"
        description="Pushes to your phone through ntfy, a free notification app for iPhone and Android."
        action={sourceNote('notifications')}
      >
        <Switch
          label="Send notifications"
          checked={n.ntfy.enabled}
          onChange={(v) => setN((x) => void (x.ntfy.enabled = v))}
        />
        <TextField
          label="Topic"
          value={n.ntfy.topic}
          placeholder="e.g. family-tv-9f2c41e7b3"
          hint={
            <>
              Subscribe to this topic in the ntfy app. Anyone who knows the name can read it, so keep it long and
              random.{' '}
              <button
                type="button"
                className="text-accent underline underline-offset-2"
                onClick={() => setN((x) => void (x.ntfy.topic = privateTopic()))}
              >
                Make a private topic
              </button>
            </>
          }
          onChange={(v) => setN((x) => void (x.ntfy.topic = v.trim()))}
        />
        <TextField
          label="Server"
          value={n.ntfy.server}
          inputMode="url"
          onChange={(v) => setN((x) => void (x.ntfy.server = v.trim()))}
        />
        <p className="mb-2 text-sm text-muted">
          Access token:{' '}
          {n.tokenConfigured
            ? 'set in .env on the PC.'
            : 'none. For a protected topic, add NTFY_TOKEN to .env on the PC.'}
        </p>
        <div className="divide-y divide-line">
          <Switch
            label="Blocked app opened"
            checked={n.events.blockedApp}
            onChange={(v) => setN((x) => void (x.events.blockedApp = v))}
          />
          <Switch
            label="Time’s up"
            checked={n.events.budgetExhausted}
            onChange={(v) => setN((x) => void (x.events.budgetExhausted = v))}
          />
          <Switch
            label="TV switched on at night"
            description="During quiet hours or outside viewing hours"
            checked={n.events.scheduleViolation}
            onChange={(v) => setN((x) => void (x.events.scheduleViolation = v))}
          />
          <Switch
            label="Control blocked"
            description="Someone changed the TV’s mobile-app setting"
            checked={n.events.restricted}
            onChange={(v) => setN((x) => void (x.events.restricted = v))}
          />
          <Switch
            label="TV unreachable"
            checked={n.events.unreachable}
            onChange={(v) => setN((x) => void (x.events.unreachable = v))}
          />
          {n.events.unreachable && (
            <div className="flex min-h-12 items-center justify-between gap-3 py-2">
              <span className="text-[15px]">Tell me after</span>
              <MinutesStepper
                label="unreachable delay"
                value={n.unreachableAfterMin}
                step={15}
                min={15}
                max={720}
                onChange={(v) => setN((x) => void (x.unreachableAfterMin = v ?? 30))}
              />
            </div>
          )}
          <Switch
            label="Include practice-mode actions"
            checked={n.includeDryRun}
            onChange={(v) => setN((x) => void (x.includeDryRun = v))}
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={!changed('notifications')}
            busy={busy === 'notifications'}
            onClick={() => {
              const { tokenConfigured: _t, ...body } = draft.notifications;
              void save('notifications', body, 'Notification settings saved');
            }}
          >
            Save notifications
          </Button>
          <Button
            disabled={!s.data.notifications.ntfy.topic}
            onClick={async () => {
              try {
                toast((await api.post<ActionResultDto>('/api/notifications/test')).message);
              } catch (err) {
                toast((err as Error).message, 'error');
              }
            }}
          >
            Send a test
          </Button>
        </div>
      </Section>

      <Section title="Enforcement" description="How firmly rules are applied." action={sourceNote('enforcement')}>
        <Row
          label="Turn the TV off after"
          hint={`repeated blocked apps within ${draft.enforcement.escalation.windowMin} minutes`}
        >
          <Counter
            value={draft.enforcement.escalation.repeats}
            min={0}
            max={10}
            format={(v) => (v === 0 ? 'Never' : `${v} tries`)}
            onChange={(v) =>
              setDraft((d) => ({
                ...d!,
                enforcement: { ...d!.enforcement, escalation: { ...d!.enforcement.escalation, repeats: v } },
              }))
            }
          />
        </Row>
        <Row label="Wait between Home presses">
          <Counter
            value={draft.enforcement.cooldownSec}
            min={5}
            max={120}
            step={5}
            format={(v) => `${v} s`}
            onChange={(v) => setDraft((d) => ({ ...d!, enforcement: { ...d!.enforcement, cooldownSec: v } }))}
          />
        </Row>
        <Row label="Check the TV every">
          <Counter
            value={draft.monitor.pollIntervalSec}
            min={2}
            max={60}
            format={(v) => `${v} s`}
            onChange={(v) => setDraft((d) => ({ ...d!, monitor: { pollIntervalSec: v } }))}
          />
        </Row>
        <Button
          variant="primary"
          className="mt-3"
          disabled={!changed('enforcement') && !changed('monitor')}
          busy={busy === 'enforcement' || busy === 'monitor'}
          onClick={async () => {
            if (changed('enforcement')) await save('enforcement', draft.enforcement, 'Enforcement saved');
            if (changed('monitor')) await save('monitor', draft.monitor, 'Check interval saved');
          }}
        >
          Save enforcement
        </Button>
      </Section>

      <Section title="Security">
        <PinChange />
        <Button className="mt-4" onClick={onSignOut}>
          Sign out of this phone
        </Button>
      </Section>

      <Section title="Appearance">
        <div className="grid grid-cols-3 gap-2">
          {[
            { v: 'system', l: 'Automatic' },
            { v: 'light', l: 'Light' },
            { v: 'dark', l: 'Dark' },
          ].map((o) => (
            <Button key={o.v} variant={theme === o.v ? 'primary' : 'quiet'} onClick={() => setTheme(o.v)}>
              {o.l}
            </Button>
          ))}
        </div>
      </Section>

      <p className="pt-6 text-sm text-faint">
        Roku TV Parental Control {draft.version}, times shown in {draft.timezone.replace('_', ' ')}.
      </p>
    </div>
  );
}

/** A QR code for the dashboard's Wi-Fi address, to open it on a phone (hidden on an older service). */
function PhoneSection() {
  const phone = useApi<PhoneLinkDto>('/api/phone');
  if (!phone.data?.url || !phone.data.qrSvg) return null;
  return (
    <Section
      title="Use it on your phone"
      description="Connect the phone to the same Wi-Fi as this PC, then point its camera at the code."
    >
      <div className="flex items-center gap-4">
        <div
          role="img"
          aria-label={`QR code for ${phone.data.url}`}
          className="w-32 shrink-0 rounded-xl bg-white p-1.5 [&>svg]:block [&>svg]:w-full"
          dangerouslySetInnerHTML={{ __html: phone.data.qrSvg }}
        />
        <div className="min-w-0 text-[15px]">
          <p className="text-muted">Or type</p>
          <p className="font-medium break-all">{phone.data.url}</p>
          <p className="mt-2 text-sm text-muted">Then choose “Add to Home Screen” so it opens like an app.</p>
        </div>
      </div>
    </Section>
  );
}

function TvMessagesSection({
  draft,
  saved,
  source,
  busy,
  onChange,
  onSave,
  onRefresh,
  onTest,
}: {
  draft: SettingsDto['tvMessages'];
  saved: SettingsDto['tvMessages'];
  source: ReactNode;
  busy: boolean;
  onChange: (tv: SettingsDto['tvMessages']) => void;
  onSave: () => void;
  onRefresh: () => void;
  onTest: () => void;
}) {
  const set = <K extends keyof SettingsDto['tvMessages']>(k: K, v: SettingsDto['tvMessages'][K]): void =>
    onChange({ ...draft, [k]: v });
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const update = saved.installed && newerVersion(saved.packageVersion, saved.installedVersion);
  return (
    <Section
      title="TV messages"
      description="With the Parental Control channel on the TV, the rules explain themselves: a message instead of a sudden jump to Home, and a countdown before the TV switches off."
      action={source}
    >
      {saved.installed ? (
        <p className="mb-2 flex items-center gap-2 text-[15px]">
          <Icon name="check" className="text-good" />
          On the TV{saved.installedVersion ? `, version ${saved.installedVersion}` : ''}
        </p>
      ) : (
        <div className="mb-3">
          <Banner tone="info" icon="tv">
            <p className="font-medium">The channel isn’t on the TV yet.</p>
            <p className="mt-1 text-sm text-muted">
              Turn on developer mode on the TV with the remote: Home three times, Up twice, then Right, Left, Right,
              Left, Right, and choose a password. On the PC, add <code>ROKU_DEV_PASSWORD=</code> with that password to
              the .env file, then run <code>npm run channel:install</code>.
            </p>
          </Banner>
        </div>
      )}
      {update && (
        <p className="mb-2 text-sm text-muted">
          Version {saved.packageVersion} is ready. On the PC, run <code>npm run channel:install</code>.
        </p>
      )}
      <Switch
        label="Explain on the TV"
        description="Off: straight to Home or off, with no message"
        checked={draft.enabled}
        onChange={(v) => set('enabled', v)}
      />
      <Row label="Countdown before switching off" hint="For quiet hours and outside viewing hours">
        <Counter
          value={draft.countdownSec}
          min={0}
          max={120}
          step={10}
          format={(v) => (v === 0 ? 'None' : `${v} s`)}
          onChange={(v) => set('countdownSec', v)}
        />
      </Row>
      <Row label="Warn before time runs out" hint="Interrupts the show for a few seconds">
        <Counter
          value={draft.warnBeforeMin}
          min={0}
          max={15}
          step={5}
          format={(v) => (v === 0 ? 'Off' : `${v} min`)}
          onChange={(v) => set('warnBeforeMin', v)}
        />
      </Row>
      {/* Hidden until the service is rebuilt: an older server doesn't know about rewritten messages. */}
      {saved.texts !== undefined && (
        <a
          href="#/settings/messages"
          className="mt-1 flex min-h-14 items-center justify-between gap-3 rounded-2xl bg-raised px-4 py-3 hover:bg-accent-soft"
        >
          <span className="text-[15px]">
            What the TV says
            <span className="block text-sm text-muted">
              {changedCount(saved.texts) === 0
                ? 'The original words. Change any message.'
                : changedCount(saved.texts) === 1
                  ? '1 message in your own words'
                  : `${changedCount(saved.texts)} messages in your own words`}
            </span>
          </span>
          <Icon name="chevron" className="shrink-0 text-faint" />
        </a>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" disabled={!dirty} busy={busy} onClick={onSave}>
          Save TV messages
        </Button>
        {saved.installed ? (
          <Button onClick={onTest}>Show a test message</Button>
        ) : (
          <Button onClick={onRefresh}>Check again</Button>
        )}
      </div>
    </Section>
  );
}

/** "1.0.2" vs "1.0.00001": compared part by part, as numbers. */
function newerVersion(available: string | null, installed: string | null): boolean {
  if (!available || !installed) return false;
  const a = available.split('.').map((n) => parseInt(n, 10) || 0);
  const b = installed.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-3 py-1">
      <span className="text-[15px]">
        {label}
        {hint && <span className="block text-sm text-muted">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

function Counter({
  value,
  onChange,
  min,
  max,
  step = 1,
  format,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  format: (v: number) => string;
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        aria-label="Less"
        onClick={() => onChange(Math.max(min, value - step))}
        className="grid size-10 place-items-center rounded-full bg-raised text-lg"
      >
        −
      </button>
      <output className="tabular min-w-20 text-center text-[15px] font-medium">{format(value)}</output>
      <button
        type="button"
        aria-label="More"
        onClick={() => onChange(Math.min(max, value + step))}
        className="grid size-10 place-items-center rounded-full bg-raised text-lg"
      >
        +
      </button>
    </div>
  );
}

function PinChange() {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const valid = /^\d{4,12}$/.test(next) && next === again && current.length >= 4;
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await api.post('/api/settings/pin', { current, next });
          setCurrent('');
          setNext('');
          setAgain('');
          toast('PIN changed. Other devices were signed out.');
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <TextField
        label="Current PIN"
        type="password"
        inputMode="numeric"
        value={current}
        onChange={setCurrent}
        autoComplete="current-password"
      />
      <TextField
        label="New PIN"
        type="password"
        inputMode="numeric"
        value={next}
        onChange={setNext}
        hint="4 to 12 digits. Six or more is harder to guess."
        autoComplete="new-password"
      />
      <TextField
        label="New PIN again"
        type="password"
        inputMode="numeric"
        value={again}
        onChange={setAgain}
        autoComplete="new-password"
      />
      {error && (
        <div className="mt-2">
          <Banner tone="critical" icon="warning">
            {error}
          </Banner>
        </div>
      )}
      <Button type="submit" variant="primary" className="mt-2" disabled={!valid}>
        Change PIN
      </Button>
    </form>
  );
}

function privateTopic(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `tv-guardian-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
