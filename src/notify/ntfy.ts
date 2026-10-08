import type { Logger } from 'pino';
import type { NotificationsConfig } from '../config/schema.js';

export interface PushMessage {
  title: string;
  message: string;
  /** ntfy priority: 1 min … 3 default … 5 urgent. */
  priority?: 1 | 2 | 3 | 4 | 5;
  /** ntfy tags; emoji short codes render as icons (e.g. "warning", "tv"). */
  tags?: string[];
}

export interface PushResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Minimal ntfy publisher (https://docs.ntfy.sh/publish/). Uses JSON publishing to the server root,
 * which handles UTF-8 titles/emoji correctly (HTTP header publishing does not). Never throws.
 */
export class NtfyClient {
  constructor(
    private readonly getConfig: () => NotificationsConfig['ntfy'],
    private readonly token: string | undefined,
    private readonly logger: Logger,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  isConfigured(): boolean {
    const c = this.getConfig();
    return c.enabled && c.topic.length > 0;
  }

  async send(msg: PushMessage, opts: { force?: boolean } = {}): Promise<PushResult> {
    const cfg = this.getConfig();
    if (!cfg.topic || (!cfg.enabled && !opts.force)) return { ok: false, error: 'ntfy is not enabled or has no topic' };
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    try {
      const res = await this.fetchImpl(cfg.server.replace(/\/+$/, ''), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          topic: cfg.topic,
          title: msg.title,
          message: msg.message,
          priority: msg.priority ?? 3,
          tags: msg.tags ?? [],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 200);
        this.logger.warn({ status: res.status, text }, 'ntfy publish failed');
        return { ok: false, status: res.status, error: `HTTP ${res.status} ${text}`.trim() };
      }
      return { ok: true, status: res.status };
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'ntfy publish failed');
      return { ok: false, error: (err as Error).message };
    }
  }
}
