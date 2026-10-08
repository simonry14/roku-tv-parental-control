import { useCallback, useEffect, useState } from 'react';
import { api, authEvents, type AuthStateDto } from './api';
import { Icon, ToastProvider, type IconName } from './components/ui';
import { useLiveStatus } from './hooks';
import { HistoryView } from './views/History';
import { LoginView } from './views/Login';
import { MessagesView } from './views/Messages';
import { NowView } from './views/Now';
import { RulesView } from './views/Rules';
import { SettingsView } from './views/Settings';

type Tab = 'now' | 'rules' | 'history' | 'settings';
const TABS: Array<{ id: Tab; label: string; icon: IconName }> = [
  { id: 'now', label: 'Now', icon: 'now' },
  { id: 'rules', label: 'Rules', icon: 'rules' },
  { id: 'history', label: 'History', icon: 'history' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

/** "#/settings/messages/app_blocked" → ['settings', 'messages', 'app_blocked']. */
const hashPath = (): string[] => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
const tabFromHash = (): Tab => {
  const t = hashPath()[0] as Tab;
  return TABS.some((x) => x.id === t) ? t : 'now';
};

function useTheme(): [string, (t: string) => void] {
  const [theme, setTheme] = useState<string>(() => {
    try {
      return localStorage.getItem('theme') ?? 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('theme', theme);
    } catch {
      /* private mode */
    }
  }, [theme]);
  return [theme, setTheme];
}

export function App() {
  const [auth, setAuth] = useState<AuthStateDto | null>(null);
  const [theme, setTheme] = useTheme();

  const checkAuth = useCallback(() => {
    api
      .get<AuthStateDto>('/api/auth/state')
      .then(setAuth)
      .catch(() => setAuth({ pinSet: true, authenticated: false, lockedUntil: null }));
  }, []);

  useEffect(() => {
    checkAuth();
    const onUnauthorized = (): void => checkAuth();
    authEvents.addEventListener('unauthorized', onUnauthorized);
    return () => authEvents.removeEventListener('unauthorized', onUnauthorized);
  }, [checkAuth]);

  return (
    <ToastProvider>
      {!auth ? null : auth.authenticated ? (
        <Dashboard
          theme={theme}
          setTheme={setTheme}
          onSignOut={async () => {
            await api.post('/api/auth/logout').catch(() => undefined);
            checkAuth();
          }}
        />
      ) : (
        <LoginView state={auth} onSignedIn={checkAuth} />
      )}
    </ToastProvider>
  );
}

function Dashboard({
  onSignOut,
  theme,
  setTheme,
}: {
  onSignOut: () => void;
  theme: string;
  setTheme: (t: string) => void;
}) {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [path, setPath] = useState<string[]>(hashPath);
  const { status, refresh } = useLiveStatus();

  useEffect(() => {
    const onHash = (): void => {
      setTab(tabFromHash());
      setPath(hashPath());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const tz = status?.timezone ?? 'America/New_York';
  const alarm = status?.health.state === 'restricted';

  return (
    <>
      <main className="mx-auto max-w-xl px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-[calc(6rem+env(safe-area-inset-bottom))]">
        {tab === 'now' && <NowView status={status} refresh={refresh} />}
        {tab === 'rules' && <RulesView />}
        {tab === 'history' && <HistoryView tz={tz} />}
        {tab === 'settings' &&
          (path[1] === 'messages' ? (
            <MessagesView messageKey={path[2] ?? null} />
          ) : (
            <SettingsView onSignOut={onSignOut} theme={theme} setTheme={setTheme} />
          ))}
      </main>
      <nav
        aria-label="Sections"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
      >
        <ul className="mx-auto grid max-w-xl grid-cols-4">
          {TABS.map((t) => (
            <li key={t.id}>
              <a
                href={`#/${t.id}`}
                aria-current={tab === t.id ? 'page' : undefined}
                className={`relative flex min-h-16 flex-col items-center justify-center gap-1 text-xs ${tab === t.id ? 'text-accent' : 'text-muted'}`}
              >
                <Icon name={t.icon} size={22} />
                {t.label}
                {t.id === 'now' && alarm && (
                  <span
                    className="absolute top-3 right-[calc(50%-18px)] size-2.5 rounded-full bg-critical"
                    aria-label="Alert"
                  />
                )}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
