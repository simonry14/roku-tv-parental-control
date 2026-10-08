import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, type ApiError, type AuthStateDto } from '../api';
import { Icon } from '../components/ui';

/** PIN entry styled after a remote's number pad. Works with a hardware keyboard too. */
export function LoginView({ state, onSignedIn }: { state: AuthStateDto; onSignedIn: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    async (value: string) => {
      if (value.length < 4 || busy) return;
      setBusy(true);
      setError(null);
      try {
        await api.post('/api/auth/login', { pin: value });
        onSignedIn();
      } catch (err) {
        const e = err as ApiError;
        setError(e.status === 401 ? 'That PIN isn’t right.' : e.message);
        setPin('');
      } finally {
        setBusy(false);
      }
    },
    [busy, onSignedIn],
  );

  const press = useCallback(
    (k: string) => {
      setError(null);
      if (k === 'back') setPin((p) => p.slice(0, -1));
      else if (k === 'ok') void submit(pin);
      else setPin((p) => (p.length < 12 ? p + k : p));
    },
    [pin, submit],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('back');
      else if (e.key === 'Enter') press('ok');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press]);

  if (!state.pinSet) {
    return (
      <Shell>
        <h1 className="text-2xl font-semibold">Set a PIN on the PC first</h1>
        <p className="mt-2 max-w-xs text-[15px] text-muted">
          For safety, the dashboard PIN can only be created on the computer running Roku TV Parental Control. In its
          folder, run:
        </p>
        <code className="mt-4 rounded-xl bg-surface px-4 py-3 text-[15px]">npm run set-pin -- 123456</code>
        <p className="mt-3 text-sm text-muted">Use your own 4 to 12 digits, then reload this page.</p>
      </Shell>
    );
  }

  const locked = state.lockedUntil && state.lockedUntil > Date.now();
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'ok'];

  return (
    <Shell>
      <h1 className="text-2xl font-semibold">Enter your PIN</h1>
      <div className="mt-6 flex h-4 items-center gap-3" aria-live="polite" aria-label={`${pin.length} digits entered`}>
        {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
          <span
            key={i}
            className={`size-3.5 rounded-full transition-colors ${i < pin.length ? 'bg-accent' : 'bg-line'}`}
          />
        ))}
      </div>
      <p className="mt-4 h-5 text-[15px] text-critical" role="alert">
        {locked
          ? `Too many wrong PINs. Try again after ${new Date(state.lockedUntil!).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
          : error}
      </p>
      <div className="mt-4 grid grid-cols-3 gap-4">
        {keys.map((k) => (
          <button
            key={k}
            type="button"
            disabled={busy || Boolean(locked) || (k === 'ok' && pin.length < 4)}
            onClick={() => press(k)}
            aria-label={k === 'back' ? 'Delete' : k === 'ok' ? 'Sign in' : k}
            className={`grid size-[4.5rem] place-items-center rounded-full text-2xl font-medium transition-colors disabled:opacity-40 ${
              k === 'ok' ? 'bg-accent text-accent-ink' : 'bg-surface hover:bg-raised'
            }`}
          >
            {k === 'back' ? <Icon name="back" size={22} /> : k === 'ok' ? <Icon name="check" size={24} /> : k}
          </button>
        ))}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-6 py-10 text-center">
      <div className="mb-8 flex items-center gap-2 text-muted">
        <Icon name="tv" size={22} />
        <span className="text-[15px]">Roku TV Parental Control</span>
      </div>
      {children}
    </main>
  );
}
