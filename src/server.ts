import { parseArgs } from 'node:util';
import { createGuardian, type Guardian } from './app.js';
import { ConfigError, loadConfig } from './config/load.js';
import { createLogger } from './lib/logger.js';
import { formatLocal } from './lib/time.js';

/**
 * Process entry point for the service: `npm run dev` (tsx), `npm start` (built), and the Windows
 * service (service/launcher.mjs → this file, with ROKU_GUARDIAN_SERVICE=1).
 */

const IS_SERVICE = process.env.ROKU_GUARDIAN_SERVICE === '1';
/** Another instance counts as alive only while its heartbeat (written every poll) is this fresh. */
const HEARTBEAT_STALE_MS = 2 * 60_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // exists, but owned by another user (the service)
  }
}

/** Another Roku TV Parental Control process using this database right now, if any. */
function otherInstance(g: Guardian): { pid: number; startedAt: number } | null {
  const svc = g.repos.runtime.get<{ pid: number; startedAt: number }>('service');
  const live = g.repos.runtime.get<{ stoppedAt?: number }>('live');
  if (!svc || svc.value.pid === process.pid) return null;
  if (live?.value.stoppedAt && live.value.stoppedAt >= svc.value.startedAt) return null; // stopped cleanly
  if (!live || Date.now() - live.updatedAt > HEARTBEAT_STALE_MS) return null; // crashed long ago
  return pidAlive(svc.value.pid) ? svc.value : null;
}

/** Tells service/launcher.mjs how the start went (it keeps a trace and a start-up watchdog). */
function lifecycle(event: 'loaded' | 'started' | 'waiting' | 'failed', ...args: unknown[]): void {
  (process.emit as (name: string, ...rest: unknown[]) => boolean)(`roku-guardian:${event}`, ...args);
}

lifecycle('loaded');

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { config: { type: 'string', short: 'c' } }, allowPositionals: false });

  let config;
  try {
    config = loadConfig(values.config ? { configPath: values.config } : {});
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      lifecycle('failed', err.message);
      process.exit(2);
    }
    throw err;
  }

  const logger = createLogger(config.log, { zone: config.timezone, service: IS_SERVICE });
  logger.info({ config: config.configPath, service: IS_SERVICE }, 'Loaded configuration');

  const guardian = createGuardian(config, logger);

  // Two copies would both control the TV (and fight over the dashboard port).
  const other = otherInstance(guardian);
  if (other) {
    const since = formatLocal(other.startedAt, config.timezone, 'MMM d, h:mm a');
    if (!IS_SERVICE) {
      console.error(
        `Roku TV Parental Control is already running (process ${other.pid}, started ${since}), probably as the Windows service.\n` +
          'Use the dashboard, or stop the service first: npm run service:stop',
      );
      process.exit(3);
    }
    logger.warn(
      { pid: other.pid },
      `Another copy of Roku TV Parental Control is running (started ${since}); waiting for it to stop`,
    );
    lifecycle('waiting', other.pid);
    while (otherInstance(guardian)) await new Promise((r) => setTimeout(r, 15_000));
  }

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Shutting down');
    const force = setTimeout(() => {
      logger.error('Shutdown timed out — forcing exit');
      process.exit(1);
    }, 10_000);
    try {
      await guardian.stop();
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
    } finally {
      clearTimeout(force);
      logger.flush();
      setTimeout(() => process.exit(0), 100);
    }
  };

  // SIGBREAK = Ctrl+Break on Windows. The node-windows wrapper asks us to stop over IPC.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.on(sig, () => void shutdown(sig));
  }
  process.on('message', (msg) => {
    if (msg === 'shutdown') void shutdown('service stop');
  });
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'Unhandled promise rejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception — exiting so the service manager restarts us');
    logger.flush();
    setTimeout(() => process.exit(1), 100);
  });

  await guardian.start();
  lifecycle('started');
}

main().catch((err: unknown) => {
  console.error('Fatal startup error:', err);
  lifecycle('failed', err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
