import { closeSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import { DateTime } from 'luxon';

/**
 * A log file that starts afresh every local day (and when it grows past maxBytes):
 *   logs/roku-guardian.log               today, being written
 *   logs/roku-guardian.2026-09-29.log    earlier days (…-29.1.log etc. for size-based splits)
 * Days older than keepDays are deleted. Writes are synchronous — a few lines a minute — so a
 * crash never loses the line that explains it, and rotation is a plain close → rename → open
 * (no renaming of open files, which Windows refuses).
 */
export class RotatingLogFile {
  private fd: number | null = null;
  private size = 0;
  private day: string;
  private readonly dir: string;
  private readonly stem: string;
  private readonly ext: string;

  constructor(
    private readonly file: string,
    private readonly opts: { keepDays: number; maxBytes: number; zone?: string; now?: () => number },
  ) {
    this.dir = path.dirname(file);
    this.ext = path.extname(file) || '.log';
    this.stem = path.basename(file, this.ext);
    mkdirSync(this.dir, { recursive: true });
    this.day = this.today();
    // A file left from an earlier day becomes that day's archive before we append to it.
    try {
      const st = statSync(file);
      const fileDay = this.dayOf(st.mtimeMs);
      if (fileDay !== this.day && st.size > 0) this.archive(fileDay);
    } catch {
      // no file yet
    }
    this.open();
    this.prune();
  }

  /** pino destination interface. */
  write(chunk: string): boolean {
    const today = this.today();
    if (today !== this.day) {
      this.rotate(this.day);
      this.day = today;
      this.prune();
    } else if (this.size + Buffer.byteLength(chunk) > this.opts.maxBytes && this.size > 0) {
      this.rotate(this.day);
    }
    if (this.fd === null) this.open();
    this.size += writeSync(this.fd!, chunk);
    return true;
  }

  close(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private dayOf(ms: number): string {
    return DateTime.fromMillis(ms, this.opts.zone ? { zone: this.opts.zone } : {}).toISODate()!;
  }

  private today(): string {
    return this.dayOf(this.now());
  }

  private open(): void {
    this.fd = openSync(this.file, 'a');
    try {
      this.size = statSync(this.file).size;
    } catch {
      this.size = 0;
    }
  }

  private rotate(day: string): void {
    this.close();
    this.archive(day);
    this.open();
  }

  /** Rename the current file to its day's archive name (first free .N suffix). */
  private archive(day: string): void {
    let target = path.join(this.dir, `${this.stem}.${day}${this.ext}`);
    for (let n = 1; exists(target); n++) target = path.join(this.dir, `${this.stem}.${day}.${n}${this.ext}`);
    try {
      renameSync(this.file, target);
    } catch {
      // Another process holds it (Windows) — keep appending; we'll try again tomorrow.
    }
  }

  private prune(): void {
    const re = new RegExp(`^${escape(this.stem)}\\.(\\d{4}-\\d{2}-\\d{2})(?:\\.\\d+)?${escape(this.ext)}$`);
    const cutoff = DateTime.fromISO(this.day).minus({ days: this.opts.keepDays }).toISODate()!;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const m = re.exec(name);
      if (m && m[1]! <= cutoff) rmSync(path.join(this.dir, name), { force: true });
    }
  }
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
