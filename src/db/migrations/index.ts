/**
 * Schema migrations, applied in order inside a transaction each. Embedded as TS strings (not
 * .sql files) so the built service in dist/ never depends on copying assets.
 *
 * Rules: never edit a shipped migration — add a new one. All timestamps are UTC epoch ms.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: /* sql */ `
      -- The TV(s) we have seen. Exactly one may be pinned; enforcement follows the pinned serial.
      CREATE TABLE devices (
        serial        TEXT PRIMARY KEY,
        name          TEXT,
        model         TEXT,
        host          TEXT,
        port          INTEGER NOT NULL DEFAULT 8060,
        macs          TEXT NOT NULL DEFAULT '[]',       -- JSON array, lower-case colon MACs
        pinned        INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
        first_seen_at INTEGER NOT NULL,
        last_seen_at  INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX devices_single_pinned ON devices (pinned) WHERE pinned = 1;

      -- Installed channels / inputs as reported by /query/apps.
      CREATE TABLE apps (
        app_id        TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        type          TEXT,
        version       TEXT,
        installed     INTEGER NOT NULL DEFAULT 1 CHECK (installed IN (0, 1)),
        first_seen_at INTEGER NOT NULL,
        last_seen_at  INTEGER NOT NULL
      );

      -- Contiguous stretches of one activity. Counted time = COALESCE(ended_at, last_seen_at) - started_at.
      -- ended_at is always a confirmed observation time, so unobserved time is never counted.
      CREATE TABLE sessions (
        id            INTEGER PRIMARY KEY,
        device_serial TEXT NOT NULL,
        kind          TEXT NOT NULL CHECK (kind IN ('app', 'home', 'screensaver')),
        app_id        TEXT,
        app_name      TEXT,
        started_at    INTEGER NOT NULL,
        last_seen_at  INTEGER NOT NULL,
        ended_at      INTEGER,
        end_reason    TEXT CHECK (end_reason IN ('switch', 'power_off', 'unreachable', 'restricted', 'gap', 'recovered', 'shutdown')),
        duration_ms   INTEGER GENERATED ALWAYS AS (COALESCE(ended_at, last_seen_at) - started_at) VIRTUAL,
        CHECK (last_seen_at >= started_at),
        CHECK (ended_at IS NULL OR ended_at = last_seen_at),
        CHECK ((kind = 'app') = (app_id IS NOT NULL) OR kind = 'screensaver')
      );
      -- At most one open session, globally: the backbone of "never double-count".
      CREATE UNIQUE INDEX sessions_single_open ON sessions ((ended_at IS NULL)) WHERE ended_at IS NULL;
      CREATE INDEX sessions_started_at ON sessions (started_at);
      CREATE INDEX sessions_app_started ON sessions (app_id, started_at);

      -- Append-only log: health changes, discovery, service lifecycle (+ enforcement in Phase 2).
      CREATE TABLE events (
        id       INTEGER PRIMARY KEY,
        at       INTEGER NOT NULL,
        type     TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error')),
        message  TEXT NOT NULL,
        data     TEXT                                     -- JSON
      );
      CREATE INDEX events_at ON events (at);
      CREATE INDEX events_type_at ON events (type, at);

      -- Dashboard-editable settings (overlay on config.json; wired up in Phase 3).
      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,                         -- JSON
        updated_at INTEGER NOT NULL
      );

      -- Small runtime key/value store: live status snapshot, heartbeat. Read by the CLI.
      CREATE TABLE runtime_state (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,                         -- JSON
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'overrides_and_bonus',
    sql: /* sql */ `
      -- Parent override: pause ("parent is watching") or lock (keep the TV off). Singleton row.
      CREATE TABLE overrides (
        id     INTEGER PRIMARY KEY CHECK (id = 1),
        kind   TEXT NOT NULL CHECK (kind IN ('pause', 'lock')),
        until  INTEGER,                                   -- NULL = until cleared
        set_at INTEGER NOT NULL,
        note   TEXT
      );

      -- Bonus minutes per local day (yyyy-MM-dd); added to global and per-app budgets that day.
      CREATE TABLE bonus_time (
        day        TEXT PRIMARY KEY,
        minutes    INTEGER NOT NULL CHECK (minutes >= 0),
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: 'dashboard_auth_and_icons',
    sql: /* sql */ `
      -- Dashboard login sessions. Only a SHA-256 of the cookie token is stored.
      CREATE TABLE auth_sessions (
        token_hash   TEXT PRIMARY KEY,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        ip           TEXT,
        user_agent   TEXT
      );
      CREATE INDEX auth_sessions_expires ON auth_sessions (expires_at);

      -- Channel icons fetched from the TV (GET /query/icon/{id}), cached for the dashboard.
      CREATE TABLE app_icons (
        app_id       TEXT PRIMARY KEY,
        content_type TEXT NOT NULL,
        data         BLOB NOT NULL,
        fetched_at   INTEGER NOT NULL
      );
    `,
  },
];
