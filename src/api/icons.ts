import type { Logger } from 'pino';
import type { Db } from '../db/database.js';
import type { Clock } from '../lib/time.js';

const TTL_MS = 7 * 86_400_000;
const PALETTE = ['#e4572e', '#29335c', '#f3a712', '#669bbc', '#2a9d8f', '#8e5572', '#3d5a80', '#bc4b51', '#5b8e7d'];

export interface Icon {
  contentType: string;
  data: Buffer;
  /** Generated placeholder (TV unreachable, or icons blocked in Limited mode). */
  placeholder: boolean;
}

/**
 * Channel icons for the dashboard: fetched from the TV once (GET /query/icon/{id}), cached in
 * SQLite for a week, and replaced by a generated initials tile when the TV can't provide one.
 */
export class IconCache {
  private readonly inflight = new Map<string, Promise<Icon>>();

  constructor(
    private readonly db: Db,
    private readonly fetchIcon: (appId: string) => Promise<{ contentType: string; data: Buffer }>,
    private readonly nameFor: (appId: string) => string | null,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  get(appId: string): Promise<Icon> {
    const cached = this.db
      .prepare('SELECT content_type, data, fetched_at FROM app_icons WHERE app_id = ?')
      .get(appId) as { content_type: string; data: Buffer; fetched_at: number } | undefined;
    if (cached && this.clock.now() - cached.fetched_at < TTL_MS) {
      return Promise.resolve({ contentType: cached.content_type, data: cached.data, placeholder: false });
    }
    const pending = this.inflight.get(appId);
    if (pending) return pending;
    const p = this.fetchAndStore(appId, cached).finally(() => this.inflight.delete(appId));
    this.inflight.set(appId, p);
    return p;
  }

  private async fetchAndStore(appId: string, stale?: { content_type: string; data: Buffer }): Promise<Icon> {
    try {
      const icon = await this.fetchIcon(appId);
      if (!icon.data.length || !/^image\//.test(icon.contentType))
        throw new Error(`not an image (${icon.contentType})`);
      this.db
        .prepare(
          `INSERT INTO app_icons (app_id, content_type, data, fetched_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (app_id) DO UPDATE SET content_type = excluded.content_type, data = excluded.data, fetched_at = excluded.fetched_at`,
        )
        .run(appId, icon.contentType, icon.data, this.clock.now());
      return { ...icon, placeholder: false };
    } catch (err) {
      this.logger.debug({ appId, err: (err as Error).message }, 'Icon fetch failed');
      if (stale) return { contentType: stale.content_type, data: stale.data, placeholder: false };
      return {
        contentType: 'image/svg+xml',
        data: Buffer.from(placeholderSvg(appId, this.nameFor(appId))),
        placeholder: true,
      };
    }
  }
}

export function placeholderSvg(appId: string, name: string | null): string {
  let h = 0;
  for (const ch of appId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const color = PALETTE[h % PALETTE.length]!;
  const label = (name ?? appId)
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  const text = (label || '?').replace(/[<>&"]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="290" height="218" viewBox="0 0 290 218"><rect width="290" height="218" rx="24" fill="${color}"/><text x="145" y="138" font-family="system-ui,Segoe UI,sans-serif" font-size="88" font-weight="700" fill="#fff" text-anchor="middle">${text}</text></svg>`;
}
