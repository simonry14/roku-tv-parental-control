// Entry point for the Windows service (npm run service:install).
//
// It lives here rather than in dist/ because node-windows keeps its wrapper files next to the
// script (service/daemon/) and dist/ is deleted on every build. After changing the code:
//   npm run build && npm run service:restart
//
// Before anything else loads, it notes each start in logs/service/launcher.log, so a start that
// fails before the app's own log is open still leaves a reason behind. A watchdog exits (and the
// wrapper starts a fresh copy) if the app isn't up within 3 minutes.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

const traceFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs', 'service', 'launcher.log');

function trace(message) {
  try {
    mkdirSync(path.dirname(traceFile), { recursive: true });
    try {
      if (statSync(traceFile).size > 512 * 1024) renameSync(traceFile, `${traceFile}.old`);
    } catch {
      // no trace yet
    }
    appendFileSync(traceFile, `${new Date().toISOString()} [${process.pid}] ${message}\n`);
  } catch {
    // tracing must never stop the service
  }
}

trace(`Starting Roku TV Parental Control (Node ${process.version})`);
process.on('exit', (code) => trace(`Stopped (exit code ${code})`));

const watchdog = setTimeout(() => {
  trace('Not up after 3 minutes; exiting so the service starts a fresh copy');
  process.exit(1);
}, 3 * 60_000);
watchdog.unref();
// Sent by src/server.ts.
process.once('roku-guardian:started', () => {
  clearTimeout(watchdog);
  trace('Running');
});
process.once('roku-guardian:failed', (reason) => trace(`Could not start: ${reason}`));
process.once('roku-guardian:waiting', (pid) => {
  clearTimeout(watchdog);
  trace(`Waiting for another copy (process ${pid}) to stop`);
});

let reports = false;
process.once('roku-guardian:loaded', () => (reports = true));
try {
  await import('../dist/src/server.js');
  if (!reports) {
    // A build from before v0.5.1 doesn't say when it's up; don't let the watchdog stop it.
    clearTimeout(watchdog);
    trace('Running (an older build: run npm run build, then npm run service:restart)');
  }
} catch (err) {
  trace(`Could not load the app: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
}
