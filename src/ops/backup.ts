import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { DateTime } from 'luxon';
import type { Logger } from 'pino';
import type { Config } from '../config/schema.js';
import type { Db } from '../db/database.js';
import type { EventsRepo } from '../db/repo.js';
import type { Clock } from '../lib/time.js';

/**
 * Nightly database backups: SQLite's online backup API (consistent while the service writes),
 * one file per local day, data/backups/roku-guardian-YYYY-MM-DD.db, keeping the newest `keep`.
 * Checked every few minutes rather than scheduled once, so a PC that slept through the backup
 * time (or a service started later in the day) still makes today's copy.
 */

export interface BackupFile {
  day: string;
  file: string;
  bytes: number;
}

const PATTERN = /^roku-guardian-(\d{4}-\d{2}-\d{2})\.db$/;
const CHECK_EVERY_MS = 10 * 60_000;

export class BackupService {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<BackupFile | null> | null = null;

  constructor(
    private readonly deps: {
      db: Db;
      config: Config['backup'];
      zone: string;
      clock: Clock;
      logger: Logger;
      events?: EventsRepo;
    },
  ) {}

  start(): void {
    if (!this.deps.config.enabled || this.timer) return;
    const check = (): void => {
      void this.runIfDue().catch((err: unknown) => this.deps.logger.error({ err }, 'Backup check failed'));
    };
    this.timer = setInterval(check, CHECK_EVERY_MS);
    this.timer.unref();
    setTimeout(check, 30_000).unref(); // shortly after start-up, not during it
  }

  stop(): Promise<unknown> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this.running ?? Promise.resolve();
  }

  list(): BackupFile[] {
    const dir = this.deps.config.dir;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names
      .map((name) => ({ name, m: PATTERN.exec(name) }))
      .filter((x): x is { name: string; m: RegExpExecArray } => x.m !== null)
      .map(({ name, m }) => {
        const file = path.join(dir, name);
        return { day: m[1]!, file, bytes: statSync(file).size };
      })
      .sort((a, b) => b.day.localeCompare(a.day));
  }

  /** Today's backup, if it's past the backup time and there isn't one yet. */
  async runIfDue(now = this.deps.clock.now()): Promise<BackupFile | null> {
    const { config, zone } = this.deps;
    if (!config.enabled) return null;
    const local = DateTime.fromMillis(now, { zone });
    const [h, m] = config.time.split(':').map(Number) as [number, number];
    if (local.hour * 60 + local.minute < h * 60 + m) return null;
    const day = local.toISODate()!;
    if (this.list().some((b) => b.day === day)) return null;
    return this.backupNow(now);
  }

  /** Back up now (replacing today's file if there is one) and prune old ones. */
  backupNow(now = this.deps.clock.now()): Promise<BackupFile | null> {
    if (this.running) return this.running;
    this.running = this.doBackup(now).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doBackup(now: number): Promise<BackupFile | null> {
    const { db, config, zone, logger, events } = this.deps;
    const day = DateTime.fromMillis(now, { zone }).toISODate()!;
    const file = path.join(config.dir, `roku-guardian-${day}.db`);
    const tmp = `${file}.partial`;
    try {
      mkdirSync(config.dir, { recursive: true });
      rmSync(tmp, { force: true });
      await db.backup(tmp);
      renameSync(tmp, file);
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // nothing to clean up
      }
      const message = `Database backup failed: ${(err as Error).message}`;
      logger.error({ err, file }, message);
      events?.add({ at: now, type: 'service', severity: 'error', message });
      return null;
    }
    const removed = this.prune();
    const result = { day, file, bytes: statSync(file).size };
    logger.info({ file, bytes: result.bytes, removed }, 'Database backed up');
    events?.add({
      at: now,
      type: 'service',
      severity: 'info',
      message: `Database backed up (${Math.max(1, Math.round(result.bytes / 1024))} KB)`,
    });
    return result;
  }

  private prune(): string[] {
    const removed: string[] = [];
    for (const old of this.list().slice(this.deps.config.keep)) {
      rmSync(old.file, { force: true });
      removed.push(path.basename(old.file));
    }
    return removed;
  }
}
