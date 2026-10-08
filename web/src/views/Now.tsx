import { useState } from 'react';
import { api, type ActionResultDto, type StatusDto } from '../api';
import { TvScreen } from '../components/TvScreen';
import { Banner, Button, Icon, Sheet, Switch, useToast } from '../components/ui';
import { clock, duration, durationParts, whenLabel } from '../format';
import { useNow } from '../hooks';

const MAX_MESSAGE = 140;
const PRESETS = ['Dinner’s ready!', 'Time for bed', 'Come and find me, please', 'Five more minutes, then off'];

const HEALTH_COPY: Record<StatusDto['health']['state'], { label: string; tone: string }> = {
  online: { label: 'Connected', tone: 'bg-good' },
  tv_off: { label: 'Connected, TV off', tone: 'bg-good' },
  offline: { label: 'Can’t reach the TV', tone: 'bg-[var(--warning-mark)]' },
  searching: { label: 'Looking for the TV', tone: 'bg-[var(--warning-mark)]' },
  starting: { label: 'Connecting', tone: 'bg-faint' },
  restricted: { label: 'Control blocked', tone: 'bg-critical' },
};

export function NowView({ status, refresh }: { status: StatusDto | null; refresh: () => void }) {
  const toast = useToast();
  const [pauseOpen, setPauseOpen] = useState(false);
  const [messageOpen, setMessageOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  if (!status) return <p className="py-24 text-center text-muted">Loading…</p>;

  const run = async (key: string, path: string, body: unknown = {}): Promise<void> => {
    setBusy(key);
    try {
      const r = await api.post<ActionResultDto>(path, body);
      toast(r.message);
      refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const { override, health, enforcement, decision } = status;
  const tz = status.timezone;
  const locked = override?.kind === 'lock';
  const paused = override?.kind === 'pause';
  const health_ = HEALTH_COPY[health.state];

  return (
    <div className="space-y-7">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="flex items-center gap-2 text-muted">
          <span className={`size-2.5 rounded-full ${health_.tone}`} aria-hidden="true" />
          {health_.label}
        </span>
        {enforcement.mode !== 'enforce' && (
          <a href="#/rules" className="rounded-full bg-raised px-3 py-1 text-muted hover:text-text">
            {enforcement.mode === 'dry-run' ? 'Practice mode' : 'Rules off'}
          </a>
        )}
      </div>

      {health.state === 'restricted' && (
        <Banner tone="critical" icon="warning">
          <p className="font-medium">The TV is refusing Roku TV Parental Control’s commands.</p>
          <p className="mt-1 text-sm text-muted">
            Someone may have changed a setting. On the TV go to Settings, System, Advanced system settings, Control by
            mobile apps, and set Network access to Enabled.
          </p>
        </Banner>
      )}

      <TvScreen status={status} />

      {status.tvMessages.countdown && <CountdownBanner {...status.tvMessages.countdown} />}

      {enforcement.mode === 'dry-run' && decision && decision.action !== 'none' && (
        <Banner tone="info" icon="rules">
          Would {decision.action === 'home' ? 'go back to Home' : 'turn the TV off'}: {decision.message}. Practice mode
          is on, so nothing was done.
        </Banner>
      )}
      {override && (
        <Banner tone={locked ? 'critical' : 'info'} icon={locked ? 'lock' : 'pause'}>
          {override.message}.
        </Banner>
      )}

      <TimeLeft status={status} />

      <div className="grid grid-cols-2 gap-3">
        {locked ? (
          <Button
            variant="primary"
            icon="unlock"
            busy={busy === 'lock'}
            onClick={() => run('lock', '/api/actions/resume')}
          >
            Unlock TV
          </Button>
        ) : (
          <Button variant="danger" icon="lock" busy={busy === 'lock'} onClick={() => run('lock', '/api/actions/lock')}>
            Lock TV
          </Button>
        )}
        {paused ? (
          <Button icon="play" busy={busy === 'pause'} onClick={() => run('pause', '/api/actions/resume')}>
            Resume rules
          </Button>
        ) : (
          <Button icon="pause" onClick={() => setPauseOpen(true)}>
            Pause rules
          </Button>
        )}
        <div className="col-span-2 flex items-center gap-2 rounded-full bg-raised p-1">
          <span className="pl-4 text-[15px] text-muted">Add time</span>
          <div className="ml-auto flex gap-1">
            {[15, 30, 60].map((m) => (
              <button
                key={m}
                type="button"
                disabled={busy === `bonus${m}`}
                onClick={() => run(`bonus${m}`, '/api/actions/bonus', { minutes: m })}
                className="tabular min-h-10 rounded-full bg-surface px-4 text-[15px] font-medium hover:bg-accent-soft disabled:opacity-50"
              >
                +{m < 60 ? m : '1h'}
                {m < 60 ? <span className="text-muted"> min</span> : null}
              </button>
            ))}
          </div>
        </div>
        {status.tvMessages.installed && status.tvMessages.enabled && (
          <Button
            icon="message"
            className="col-span-2"
            disabled={!status.current || status.tvMessages.countdown !== null}
            onClick={() => setMessageOpen(true)}
          >
            {status.current ? 'Message the TV' : 'Message the TV (it’s off)'}
          </Button>
        )}
        <Button
          variant="ghost"
          icon="home"
          className="col-span-2"
          busy={busy === 'home'}
          onClick={() => run('home', '/api/actions/home')}
        >
          Send the TV to Home
        </Button>
      </div>

      <TodayByApp status={status} />

      {status.lastEnforcement && (
        <a
          href="#/history"
          className="flex items-start gap-3 rounded-2xl bg-surface px-4 py-3 text-[15px] hover:bg-raised"
        >
          <Icon name="history" className="mt-0.5 shrink-0 text-muted" />
          <span className="min-w-0">
            <span className="block">
              {status.lastEnforcement.message.replace(/^Sent /, 'Sent ').replace(' — ', ': ')}
            </span>
            <span className="text-sm text-muted">{whenLabel(status.lastEnforcement.at, tz, status.now)}</span>
          </span>
        </a>
      )}

      <MessageSheet
        open={messageOpen}
        onClose={() => setMessageOpen(false)}
        showName={status.current?.kind === 'app' && !status.tvMessages.showing ? status.current.appName : null}
        onSend={async (text, returnToShow) => {
          setMessageOpen(false);
          await run('message', '/api/actions/message', { text, returnToShow });
        }}
      />

      <Sheet open={pauseOpen} onClose={() => setPauseOpen(false)} title="Pause rules while you watch">
        <p className="mb-4 text-[15px] text-muted">
          Nothing is blocked or switched off while rules are paused. Screen time still counts.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {[
            { m: 30, l: '30 minutes' },
            { m: 60, l: '1 hour' },
            { m: 120, l: '2 hours' },
            { m: null, l: 'Until I resume' },
          ].map((o) => (
            <Button
              key={o.l}
              onClick={() => {
                setPauseOpen(false);
                void run('pause', '/api/actions/pause', { minutes: o.m });
              }}
            >
              {o.l}
            </Button>
          ))}
        </div>
      </Sheet>
    </div>
  );
}

function TimeLeft({ status }: { status: StatusDto }) {
  const { today, nextChange } = status;
  const tz = status.timezone;
  const hasBudget = today.budgetMs !== null;
  const shown = hasBudget ? today.remainingMs! : today.screenMs;
  const parts = durationParts(shown);
  const frac = hasBudget && today.budgetMs! > 0 ? Math.min(1, today.screenMs / today.budgetMs!) : 0;
  const left = today.remainingMs ?? Infinity;
  const fill = left === 0 ? 'bg-critical' : left < 15 * 60_000 ? 'bg-[var(--warning-mark)]' : 'bg-accent';

  return (
    <section aria-label="Screen time today">
      <p className="flex items-baseline gap-1.5">
        {parts.map((p) => (
          <span key={p.unit} className="flex items-baseline gap-1">
            <span className="text-[56px] leading-none font-semibold tracking-tight">{p.value}</span>
            <span className="text-xl text-muted">{p.unit}</span>
          </span>
        ))}
        <span className="ml-2 text-xl text-muted">
          {hasBudget ? (left === 0 ? 'left — time’s up' : 'left today') : 'watched today'}
        </span>
      </p>
      {hasBudget && (
        <>
          <div
            className="mt-4 h-3 overflow-hidden rounded-full bg-accent-soft"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={today.budgetMs!}
            aria-valuenow={today.screenMs}
            aria-label="Screen time used"
          >
            <div
              className={`h-full rounded-full ${fill}`}
              style={{ width: `${Math.max(frac > 0 ? 2 : 0, frac * 100)}%` }}
            />
          </div>
          <p className="mt-2 text-[15px] text-muted">
            {duration(today.screenMs)} of {duration(today.budgetMs!)} used
            {today.bonusMinutes ? `, including ${today.bonusMinutes} min bonus` : ''}
          </p>
        </>
      )}
      {nextChange && (
        <p className="mt-1 text-[15px] text-muted">
          {nextChange.label
            .replace('Viewing window closes', 'Viewing hours end')
            .replace('Viewing window opens', 'Viewing hours start')}{' '}
          at {clock(nextChange.at, tz)}
        </p>
      )}
    </section>
  );
}

function TodayByApp({ status }: { status: StatusDto }) {
  const apps = status.today.byApp;
  if (!apps.length) {
    return <p className="text-[15px] text-muted">Nothing watched yet today.</p>;
  }
  return (
    <section aria-labelledby="today-apps">
      <h2 id="today-apps" className="mb-2 text-lg font-semibold">
        Today by app
      </h2>
      <ul className="divide-y divide-line">
        {apps.map((a) => (
          <li key={a.appId} className="flex items-center gap-3 py-3">
            <img src={a.iconUrl} alt="" className="h-9 w-12 shrink-0 rounded-md object-cover" loading="lazy" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-[15px]">{a.appName}</span>
                <span className="tabular shrink-0 text-[15px] font-medium">{duration(a.ms, { short: true })}</span>
              </div>
              {a.budgetMs !== null && (
                <div className="mt-1.5 flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-accent-soft">
                    <div
                      className={`h-full rounded-full ${a.remainingMs === 0 ? 'bg-critical' : 'bg-accent'}`}
                      style={{ width: `${Math.min(100, (a.ms / a.budgetMs) * 100)}%` }}
                    />
                  </div>
                  <span className="shrink-0 text-sm text-muted">
                    {a.remainingMs === 0 ? 'Limit reached' : `${duration(a.remainingMs!, { short: true })} left`}
                  </span>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CountdownBanner({ endsAt, reason }: { endsAt: number; reason: string }) {
  const now = useNow(1000);
  const left = Math.max(0, Math.ceil((endsAt - now) / 1000));
  return (
    <Banner tone="info" icon={reason === 'lock' ? 'lock' : 'moon'}>
      {left > 0 ? `The TV turns off in ${left} s.` : 'Turning the TV off.'}
      {reason === 'lock' ? '' : ' Pause the rules to stop it.'}
    </Banner>
  );
}

function MessageSheet({
  open,
  onClose,
  showName,
  onSend,
}: {
  open: boolean;
  onClose: () => void;
  /** What's playing now, if there's a show to go back to. */
  showName: string | null;
  onSend: (text: string, returnToShow: boolean) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [goBack, setGoBack] = useState(false);
  const clean = text.trim();
  return (
    <Sheet open={open} onClose={onClose} title="Message the TV">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!clean) return;
          void onSend(clean, Boolean(showName) && goBack).then(() => setText(''));
        }}
      >
        <label htmlFor="tv-message" className="sr-only">
          Message
        </label>
        <textarea
          id="tv-message"
          value={text}
          maxLength={MAX_MESSAGE}
          rows={3}
          placeholder="Write a message"
          onChange={(e) => setText(e.target.value)}
          className="block w-full resize-none rounded-xl border border-line bg-surface px-4 py-3 text-[17px] placeholder:text-faint focus:border-accent focus:outline-none"
        />
        <p className="tabular mt-1 text-right text-sm text-faint">
          {text.length}/{MAX_MESSAGE}
        </p>
        <div className="mt-1 flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setText(p)}
              className="min-h-10 rounded-full bg-raised px-4 text-[15px] hover:bg-accent-soft"
            >
              {p}
            </button>
          ))}
        </div>
        {showName && (
          <div className="mt-3">
            <Switch label={`Then go back to ${showName}`} checked={goBack} onChange={setGoBack} />
          </div>
        )}
        <p className="mt-2 mb-4 text-sm text-muted">
          {showName && goBack
            ? `It fills the screen for 15 seconds, then ${showName} comes back.`
            : 'It fills the screen until someone presses OK on the remote.'}
        </p>
        <Button type="submit" variant="primary" icon="message" className="w-full" disabled={!clean}>
          Show on the TV
        </Button>
      </form>
    </Sheet>
  );
}
