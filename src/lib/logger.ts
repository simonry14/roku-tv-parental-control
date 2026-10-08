import pino, { type Logger, type StreamEntry } from 'pino';
import pinoPretty from 'pino-pretty';
import type { Config } from '../config/schema.js';
import { RotatingLogFile } from './log-file.js';

export type { Logger } from 'pino';

/**
 * Service logger: console (pretty when interactive) + a JSON-lines file that rotates daily
 * (log.keepDays) and by size (log.maxSizeMb). Runs in-process — at a few lines a minute there's
 * no need for a worker thread, and synchronous file writes survive a crash.
 * As a Windows service the console only gets warnings and errors: the service wrapper keeps its
 * own copy of the console, and the full log is in the file.
 */
export function createLogger(
  cfg: Config['log'],
  opts: { name?: string; zone?: string; service?: boolean } = {},
): Logger {
  const level = cfg.level;
  const pretty = cfg.pretty ?? Boolean(process.stdout.isTTY);
  const consoleLevel = opts.service && level !== 'silent' ? 'warn' : level;
  const streams: StreamEntry[] = [
    {
      level: consoleLevel as pino.Level,
      stream: pretty
        ? pinoPretty({
            colorize: true,
            translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
            ignore: 'pid,hostname,name',
            sync: true,
          })
        : pino.destination({ fd: 1, sync: true }),
    },
  ];
  if (cfg.file) {
    streams.push({
      level: level as pino.Level,
      stream: new RotatingLogFile(cfg.file, {
        keepDays: cfg.keepDays,
        maxBytes: cfg.maxSizeMb * 1024 * 1024,
        ...(opts.zone ? { zone: opts.zone } : {}),
      }),
    });
  }
  return pino(
    { name: opts.name ?? 'roku-guardian', level, timestamp: pino.stdTimeFunctions.isoTime },
    pino.multistream(streams),
  );
}

/** Synchronous stderr logger for CLI commands (keeps stdout clean for command output). */
export function createCliLogger(level: string = process.env.LOG_LEVEL ?? 'warn'): Logger {
  return pino({ name: 'cli', level }, pino.destination({ fd: 2, sync: true }));
}

/** Logger that discards everything — for tests. */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
