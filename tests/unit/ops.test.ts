import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DateTime } from 'luxon';
import { afterEach, describe, expect, it } from 'vitest';
import { RotatingLogFile } from '../../src/lib/log-file.js';
import { silentLogger } from '../../src/lib/logger.js';
import { BackupService } from '../../src/ops/backup.js';
import { fakeClock, memoryDb } from '../helpers.js';

const TZ = 'America/New_York';
const at = (iso: string): number => DateTime.fromISO(iso, { zone: TZ }).toMillis();
const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'rg-ops-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('RotatingLogFile', () => {
  it('starts a new file each local day and keeps keepDays of them', () => {
    const dir = tmp();
    let now = at('2026-09-28T23:59:00');
    const log = new RotatingLogFile(path.join(dir, 'roku-guardian.log'), {
      keepDays: 2,
      maxBytes: 1024 * 1024,
      zone: TZ,
      now: () => now,
    });
    log.write('day 28\n');
    now = at('2026-09-29T00:00:01'); // midnight in New York, not UTC
    log.write('day 29\n');
    now = at('2026-09-30T09:00');
    log.write('day 30\n');
    now = at('2026-10-01T09:00');
    log.write('day 1\n');
    log.close();
    // keepDays 2 = today's file and yesterday's; the 28th and 29th are gone.
    expect(readdirSync(dir).sort()).toEqual(['roku-guardian.2026-09-30.log', 'roku-guardian.log']);
    expect(readFileSync(path.join(dir, 'roku-guardian.2026-09-30.log'), 'utf8')).toBe('day 30\n');
    expect(readFileSync(path.join(dir, 'roku-guardian.log'), 'utf8')).toBe('day 1\n');
  });

  it('splits a day by size, and archives a file left from an earlier day at start-up', () => {
    const dir = tmp();
    const file = path.join(dir, 'roku-guardian.log');
    writeFileSync(file, 'old\n');
    const old = at('2026-09-27T12:00') / 1000;
    utimesSync(file, old, old);
    const now = at('2026-09-30T12:00');
    const log = new RotatingLogFile(file, { keepDays: 14, maxBytes: 20, zone: TZ, now: () => now });
    log.write('0123456789\n');
    log.write('0123456789\n'); // would pass 20 bytes → new file
    log.close();
    expect(readdirSync(dir).sort()).toEqual([
      'roku-guardian.2026-09-27.log',
      'roku-guardian.2026-09-30.log',
      'roku-guardian.log',
    ]);
    expect(readFileSync(path.join(dir, 'roku-guardian.2026-09-27.log'), 'utf8')).toBe('old\n');
  });
});

describe('BackupService', () => {
  it('backs up once a day after the backup time, and keeps the newest N', async () => {
    const dir = tmp();
    const { db, repos } = memoryDb();
    repos.events.add({ at: 1, type: 'service', severity: 'info', message: 'hello' });
    const clock = fakeClock(at('2026-09-30T03:00'));
    const backups = new BackupService({
      db,
      config: { enabled: true, dir, time: '03:30', keep: 2 },
      zone: TZ,
      clock,
      logger: silentLogger(),
      events: repos.events,
    });

    expect(await backups.runIfDue()).toBeNull(); // before 03:30
    clock.set(at('2026-09-30T03:31'));
    const first = await backups.runIfDue();
    expect(first?.day).toBe('2026-09-30');
    expect(await backups.runIfDue()).toBeNull(); // already done today

    // The copy is a working database with the data in it.
    const copy = new Database(first!.file, { readonly: true });
    expect(
      (copy.prepare('SELECT message FROM events WHERE message = ?').get('hello') as { message: string }).message,
    ).toBe('hello');
    copy.close();

    for (const day of ['2026-10-01', '2026-10-02']) {
      clock.set(at(`${day}T09:00`)); // the PC slept through 03:30: backs up when it wakes
      expect((await backups.runIfDue())?.day).toBe(day);
    }
    expect(backups.list().map((b) => b.day)).toEqual(['2026-10-02', '2026-10-01']);
    expect(readdirSync(dir).filter((n) => n.endsWith('.partial'))).toEqual([]);
    expect(repos.events.recent({ type: 'service' })[0]?.message).toMatch(/^Database backed up/);
  });

  it('reports a failure without throwing', async () => {
    const dir = tmp();
    const blocker = path.join(dir, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const { db, repos } = memoryDb();
    const backups = new BackupService({
      db,
      config: { enabled: true, dir: blocker, time: '00:00', keep: 7 },
      zone: TZ,
      clock: fakeClock(),
      logger: silentLogger(),
      events: repos.events,
    });
    expect(await backups.backupNow()).toBeNull();
    expect(repos.events.recent({ type: 'service' })[0]).toMatchObject({ severity: 'error' });
  });
});
