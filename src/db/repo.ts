import type { RokuApp } from '../ecp/types.js';
import type { Db } from './database.js';

// ─── Row types ──────────────────────────────────────────────────────────────

export type SessionKind = 'app' | 'home' | 'screensaver';
export type SessionEndReason = 'switch' | 'power_off' | 'unreachable' | 'restricted' | 'gap' | 'recovered' | 'shutdown';
export type EventSeverity = 'debug' | 'info' | 'warn' | 'error';

export interface DeviceRecord {
  serial: string;
  name: string | null;
  model: string | null;
  host: string | null;
  port: number;
  macs: string[];
  pinned: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface SessionRecord {
  id: number;
  deviceSerial: string;
  kind: SessionKind;
  appId: string | null;
  appName: string | null;
  startedAt: number;
  lastSeenAt: number;
  endedAt: number | null;
  endReason: SessionEndReason | null;
  durationMs: number;
}

export interface EventRecord {
  id: number;
  at: number;
  type: string;
  severity: EventSeverity;
  message: string;
  data: unknown;
}

export interface AppRecord {
  appId: string;
  name: string;
  type: string | null;
  version: string | null;
  installed: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
}

// ─── Devices ────────────────────────────────────────────────────────────────

interface DeviceRow {
  serial: string;
  name: string | null;
  model: string | null;
  host: string | null;
  port: number;
  macs: string;
  pinned: number;
  first_seen_at: number;
  last_seen_at: number;
}

const toDevice = (r: DeviceRow): DeviceRecord => ({
  serial: r.serial,
  name: r.name,
  model: r.model,
  host: r.host,
  port: r.port,
  macs: safeJson<string[]>(r.macs, []),
  pinned: r.pinned === 1,
  firstSeenAt: r.first_seen_at,
  lastSeenAt: r.last_seen_at,
});

export class DevicesRepo {
  constructor(private readonly db: Db) {}

  get(serial: string): DeviceRecord | null {
    const row = this.db.prepare('SELECT * FROM devices WHERE serial = ?').get(serial) as DeviceRow | undefined;
    return row ? toDevice(row) : null;
  }

  pinned(): DeviceRecord | null {
    const row = this.db.prepare('SELECT * FROM devices WHERE pinned = 1').get() as DeviceRow | undefined;
    return row ? toDevice(row) : null;
  }

  list(): DeviceRecord[] {
    return (this.db.prepare('SELECT * FROM devices ORDER BY last_seen_at DESC').all() as DeviceRow[]).map(toDevice);
  }

  /** Insert or refresh a device's last-known address and identity. MACs are merged, never dropped. */
  upsert(
    d: { serial: string; name?: string | null; model?: string | null; host: string; port: number; macs?: string[] },
    at: number,
  ): DeviceRecord {
    const existing = this.get(d.serial);
    const macs = [...new Set([...(existing?.macs ?? []), ...(d.macs ?? [])])];
    this.db
      .prepare(
        `INSERT INTO devices (serial, name, model, host, port, macs, pinned, first_seen_at, last_seen_at)
         VALUES (@serial, @name, @model, @host, @port, @macs, 0, @at, @at)
         ON CONFLICT (serial) DO UPDATE SET
           name = COALESCE(excluded.name, devices.name),
           model = COALESCE(excluded.model, devices.model),
           host = excluded.host,
           port = excluded.port,
           macs = excluded.macs,
           last_seen_at = excluded.last_seen_at`,
      )
      .run({
        serial: d.serial,
        name: d.name ?? null,
        model: d.model ?? null,
        host: d.host,
        port: d.port,
        macs: JSON.stringify(macs),
        at,
      });
    return this.get(d.serial)!;
  }

  pin(serial: string): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE devices SET pinned = 0 WHERE pinned = 1 AND serial <> ?').run(serial);
      this.db.prepare('UPDATE devices SET pinned = 1 WHERE serial = ?').run(serial);
    })();
  }

  touch(serial: string, at: number): void {
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE serial = ?').run(at, serial);
  }
}

// ─── Apps ───────────────────────────────────────────────────────────────────

interface AppRow {
  app_id: string;
  name: string;
  type: string | null;
  version: string | null;
  installed: number;
  first_seen_at: number;
  last_seen_at: number;
}

export class AppsRepo {
  constructor(private readonly db: Db) {}

  /** Replace the installed set with what the TV reports now; keep history for removed apps. */
  syncInstalled(apps: RokuApp[], at: number): void {
    const upsert = this.db.prepare(
      `INSERT INTO apps (app_id, name, type, version, installed, first_seen_at, last_seen_at)
       VALUES (@id, @name, @type, @version, 1, @at, @at)
       ON CONFLICT (app_id) DO UPDATE SET
         name = excluded.name, type = excluded.type, version = excluded.version,
         installed = 1, last_seen_at = excluded.last_seen_at`,
    );
    this.db.transaction(() => {
      this.db.prepare('UPDATE apps SET installed = 0').run();
      for (const a of apps) upsert.run({ id: a.id, name: a.name, type: a.type, version: a.version, at });
    })();
  }

  /** Record an app seen as active (e.g. a TV input not listed by /query/apps). */
  noteSeen(app: { id: string; name: string; type: string | null }, at: number): void {
    this.db
      .prepare(
        `INSERT INTO apps (app_id, name, type, version, installed, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, NULL, 1, ?, ?)
         ON CONFLICT (app_id) DO UPDATE SET name = excluded.name, last_seen_at = excluded.last_seen_at`,
      )
      .run(app.id, app.name, app.type, at, at);
  }

  list(opts: { installedOnly?: boolean } = {}): AppRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM apps ${opts.installedOnly ? 'WHERE installed = 1' : ''} ORDER BY name COLLATE NOCASE`)
      .all() as AppRow[];
    return rows.map((r) => ({
      appId: r.app_id,
      name: r.name,
      type: r.type,
      version: r.version,
      installed: r.installed === 1,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
    }));
  }
}

// ─── Sessions ───────────────────────────────────────────────────────────────

interface SessionRow {
  id: number;
  device_serial: string;
  kind: SessionKind;
  app_id: string | null;
  app_name: string | null;
  started_at: number;
  last_seen_at: number;
  ended_at: number | null;
  end_reason: SessionEndReason | null;
  duration_ms: number;
}

const toSession = (r: SessionRow): SessionRecord => ({
  id: r.id,
  deviceSerial: r.device_serial,
  kind: r.kind,
  appId: r.app_id,
  appName: r.app_name,
  startedAt: r.started_at,
  lastSeenAt: r.last_seen_at,
  endedAt: r.ended_at,
  endReason: r.end_reason,
  durationMs: r.duration_ms,
});

export interface NewSession {
  deviceSerial: string;
  kind: SessionKind;
  appId: string | null;
  appName: string | null;
  startedAt: number;
}

export class SessionsRepo {
  constructor(private readonly db: Db) {}

  getOpen(): SessionRecord | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE ended_at IS NULL').get() as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  get(id: number): SessionRecord | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  open(s: NewSession): number {
    const res = this.db
      .prepare(
        `INSERT INTO sessions (device_serial, kind, app_id, app_name, started_at, last_seen_at)
         VALUES (@deviceSerial, @kind, @appId, @appName, @startedAt, @startedAt)`,
      )
      .run(s);
    return Number(res.lastInsertRowid);
  }

  /** Extend an open session. Monotonic: never moves last_seen_at backwards. */
  touch(id: number, lastSeenAt: number): void {
    this.db
      .prepare('UPDATE sessions SET last_seen_at = MAX(last_seen_at, ?) WHERE id = ? AND ended_at IS NULL')
      .run(lastSeenAt, id);
  }

  /** Close an open session at its last confirmed observation. Idempotent. */
  close(id: number, reason: SessionEndReason): void {
    this.db
      .prepare('UPDATE sessions SET ended_at = last_seen_at, end_reason = ? WHERE id = ? AND ended_at IS NULL')
      .run(reason, id);
  }

  /** Sessions overlapping [start, end). Open sessions count up to last_seen_at. */
  listOverlapping(start: number, end: number): SessionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE started_at < @end AND COALESCE(ended_at, last_seen_at) > @start
         ORDER BY started_at`,
      )
      .all({ start, end }) as SessionRow[];
    return rows.map(toSession);
  }

  recent(limit = 20): SessionRecord[] {
    return (
      this.db.prepare('SELECT * FROM sessions ORDER BY started_at DESC, id DESC LIMIT ?').all(limit) as SessionRow[]
    ).map(toSession);
  }
}

// ─── Events ─────────────────────────────────────────────────────────────────

interface EventRow {
  id: number;
  at: number;
  type: string;
  severity: EventSeverity;
  message: string;
  data: string | null;
}

export class EventsRepo {
  constructor(private readonly db: Db) {}

  add(e: { at: number; type: string; severity: EventSeverity; message: string; data?: unknown }): number {
    const res = this.db
      .prepare('INSERT INTO events (at, type, severity, message, data) VALUES (?, ?, ?, ?, ?)')
      .run(e.at, e.type, e.severity, e.message, e.data === undefined ? null : JSON.stringify(e.data));
    return Number(res.lastInsertRowid);
  }

  recent(opts: { limit?: number; type?: string } = {}): EventRecord[] {
    const rows = (
      opts.type
        ? this.db
            .prepare('SELECT * FROM events WHERE type = ? ORDER BY at DESC, id DESC LIMIT ?')
            .all(opts.type, opts.limit ?? 50)
        : this.db.prepare('SELECT * FROM events ORDER BY at DESC, id DESC LIMIT ?').all(opts.limit ?? 50)
    ) as EventRow[];
    return rows.map((r) => ({ ...r, data: r.data === null ? null : safeJson<unknown>(r.data, null) }));
  }
}

// ─── Key/value stores ───────────────────────────────────────────────────────

export class KeyValueRepo {
  constructor(
    private readonly db: Db,
    private readonly table: 'settings' | 'runtime_state',
  ) {}

  get<T>(key: string): { value: T; updatedAt: number } | null {
    const row = this.db.prepare(`SELECT value, updated_at FROM ${this.table} WHERE key = ?`).get(key) as
      { value: string; updated_at: number } | undefined;
    return row ? { value: safeJson<T>(row.value, null as T), updatedAt: row.updated_at } : null;
  }

  set(key: string, value: unknown, at: number): void {
    this.db
      .prepare(
        `INSERT INTO ${this.table} (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), at);
  }

  delete(key: string): void {
    this.db.prepare(`DELETE FROM ${this.table} WHERE key = ?`).run(key);
  }

  all(): Record<string, unknown> {
    const rows = this.db.prepare(`SELECT key, value FROM ${this.table}`).all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, safeJson<unknown>(r.value, null)]));
  }
}

// ─── Overrides & bonus time ─────────────────────────────────────────────────

export interface OverrideRecord {
  kind: 'pause' | 'lock';
  until: number | null;
  setAt: number;
  note: string | null;
}

export class OverridesRepo {
  constructor(private readonly db: Db) {}

  get(): OverrideRecord | null {
    const row = this.db.prepare('SELECT kind, until, set_at, note FROM overrides WHERE id = 1').get() as
      { kind: 'pause' | 'lock'; until: number | null; set_at: number; note: string | null } | undefined;
    return row ? { kind: row.kind, until: row.until, setAt: row.set_at, note: row.note } : null;
  }

  /** Replace the override (pause and lock are mutually exclusive). */
  set(o: OverrideRecord): void {
    this.db
      .prepare(
        `INSERT INTO overrides (id, kind, until, set_at, note) VALUES (1, @kind, @until, @setAt, @note)
         ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, until = excluded.until, set_at = excluded.set_at, note = excluded.note`,
      )
      .run(o);
  }

  clear(): boolean {
    return this.db.prepare('DELETE FROM overrides WHERE id = 1').run().changes > 0;
  }

  bonusFor(day: string): number {
    const row = this.db.prepare('SELECT minutes FROM bonus_time WHERE day = ?').get(day) as
      { minutes: number } | undefined;
    return row?.minutes ?? 0;
  }

  /** Add (or with a negative number, remove) bonus minutes for a day. Never goes below 0. */
  addBonus(day: string, minutes: number, at: number): number {
    const next = Math.max(0, this.bonusFor(day) + Math.round(minutes));
    this.db
      .prepare(
        `INSERT INTO bonus_time (day, minutes, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (day) DO UPDATE SET minutes = excluded.minutes, updated_at = excluded.updated_at`,
      )
      .run(day, next, at);
    return next;
  }
}

// ─── Aggregate ──────────────────────────────────────────────────────────────

export interface Repos {
  db: Db;
  devices: DevicesRepo;
  apps: AppsRepo;
  sessions: SessionsRepo;
  events: EventsRepo;
  settings: KeyValueRepo;
  runtime: KeyValueRepo;
  overrides: OverridesRepo;
  /** Run `fn` in a single SQLite transaction. */
  tx<T>(fn: () => T): T;
}

export function createRepos(db: Db): Repos {
  return {
    db,
    devices: new DevicesRepo(db),
    apps: new AppsRepo(db),
    sessions: new SessionsRepo(db),
    events: new EventsRepo(db),
    settings: new KeyValueRepo(db, 'settings'),
    runtime: new KeyValueRepo(db, 'runtime_state'),
    overrides: new OverridesRepo(db),
    tx: <T>(fn: () => T): T => db.transaction(fn)(),
  };
}

function safeJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
