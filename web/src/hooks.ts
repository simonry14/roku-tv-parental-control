import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type StatusDto } from './api';

/**
 * Live status: Server-Sent Events from /api/stream, falling back to polling /api/status when
 * the stream drops (phone asleep, Wi-Fi hiccup), and reconnecting in the background.
 */
export function useLiveStatus(): { status: StatusDto | null; connected: boolean; refresh: () => void } {
  const [status, setStatus] = useState<StatusDto | null>(null);
  const [connected, setConnected] = useState(false);

  const refresh = useCallback(() => {
    api
      .get<StatusDto>('/api/status')
      .then(setStatus)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    let poll: number | null = null;
    let retry: number | null = null;
    let closed = false;

    const startPolling = (): void => {
      if (poll === null) poll = window.setInterval(refresh, 5000);
    };
    const stopPolling = (): void => {
      if (poll !== null) window.clearInterval(poll);
      poll = null;
    };
    const connect = (): void => {
      if (closed) return;
      es = new EventSource('/api/stream');
      es.addEventListener('status', (e) => {
        setStatus(JSON.parse((e as MessageEvent<string>).data) as StatusDto);
        setConnected(true);
        stopPolling();
      });
      es.onerror = () => {
        setConnected(false);
        es?.close();
        refresh();
        startPolling();
        if (!closed) retry = window.setTimeout(connect, 10_000);
      };
    };
    refresh();
    connect();
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      closed = true;
      es?.close();
      stopPolling();
      if (retry !== null) window.clearTimeout(retry);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  return { status, connected, refresh };
}

/** Fetch-once-with-reload helper for the less live views. */
export function useApi<T>(path: string): {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (d: T) => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.get<T>(path);
      if (mounted.current) {
        setData(d);
        setError(null);
      }
    } catch (err) {
      if (mounted.current) setError(err instanceof ApiError ? err : new ApiError(0, (err as Error).message));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  return { data, error, loading, reload, setData };
}

/** Re-render every `ms` so relative times ("3 min") stay current between updates. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}
