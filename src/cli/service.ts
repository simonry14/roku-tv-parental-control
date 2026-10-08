import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import http from 'node:http';
import { loadConfig } from '../config/load.js';
import { projectRoot } from '../lib/paths.js';
import { formatLocal } from '../lib/time.js';
import { withRepos } from './controls.js';
import { c, dim } from './format.js';
import { LEGACY_SERVICE_IDS, SERVICE_ID, windowsServiceState } from './winservice.js';

/**
 * npm run service:install | service:uninstall | service:start | service:stop | service:restart | service:status
 * (and `ensure`, used by scripts/windows/install.ps1: install, or restart the installed one)
 *
 * Runs the built service (dist/) as a Windows service with node-windows (winsw underneath): it
 * starts with Windows, before anyone logs in, and restarts if it crashes. Stopping goes through
 * the wrapper's IPC "shutdown" message, so sessions and the log are closed cleanly.
 * NSSM is a fine alternative (README §13).
 */

const NAME = 'Roku TV Parental Control';

interface NodeWindowsService {
  exists: boolean;
  on(event: string, fn: (arg?: unknown) => void): void;
  install(): void;
  uninstall(): void;
}

const root = projectRoot();
const script = path.join(root, 'service', 'launcher.mjs');
const built = path.join(root, 'dist', 'src', 'server.js');

function windowsOnly(): void {
  if (process.platform !== 'win32') {
    console.error('The service commands are for Windows. Elsewhere, run "npm start" under systemd, launchd or pm2.');
    process.exit(2);
  }
}

function requireAdmin(what: string): void {
  // `net session` only succeeds in an elevated shell.
  if (spawnSync('net', ['session'], { stdio: 'ignore', windowsHide: true }).status !== 0) {
    console.error(
      c('red', `✗ ${what} needs administrator rights.`) +
        '\n  Open Git Bash, PowerShell or Command Prompt with "Run as administrator", go to the project folder, and run it again.',
    );
    process.exit(1);
  }
}

const state = (): string => windowsServiceState() ?? 'not installed';

function net(verb: 'start' | 'stop'): void {
  try {
    execFileSync('net', [verb, SERVICE_ID], { stdio: 'inherit', windowsHide: true });
  } catch {
    // net prints its own error ("The service is not started.", etc.)
  }
}

/**
 * Windows-side settings node-windows doesn't make: start a minute or two after boot (networking
 * and the user profile are ready by then), and let Windows restart the service if it ever stops
 * on its own (for example, the wrapper giving up after repeated crashes). Safe to repeat.
 */
function harden(): void {
  const sc = (...args: string[]): boolean => spawnSync('sc', args, { stdio: 'ignore', windowsHide: true }).status === 0;
  const ok = [
    sc('config', SERVICE_ID, 'start=', 'delayed-auto'),
    sc('failure', SERVICE_ID, 'reset=', '86400', 'actions=', 'restart/10000/restart/30000/restart/60000'),
    sc('failureflag', SERVICE_ID, '1'),
  ].every(Boolean);
  if (!ok) console.log(dim('  (Could not set the start-up and recovery options; the service still works.)'));
}

/**
 * The same program was installed earlier under another name ("Roku Guardian"): stop and remove
 * that service so two copies never control the TV. Its leftover wrapper files go too.
 */
function removeLegacyServices(): void {
  for (const id of LEGACY_SERVICE_IDS) {
    if (windowsServiceState(id) === 'not installed') continue;
    console.log(dim(`  Removing the older service "${id}"…`));
    spawnSync('net', ['stop', id], { stdio: 'ignore', windowsHide: true });
    spawnSync('sc', ['delete', id], { stdio: 'ignore', windowsHide: true });
    const stem = id.replace(/\.exe$/, '');
    for (const f of [`${stem}.exe`, `${stem}.exe.config`, `${stem}.xml`]) {
      rmSync(path.join(root, 'service', 'daemon', f), { force: true });
    }
  }
}

function service(): NodeWindowsService {
  const require = createRequire(import.meta.url);
  let nw: { Service: new (opts: Record<string, unknown>) => NodeWindowsService };
  try {
    nw = require('node-windows') as typeof nw;
  } catch {
    console.error('node-windows is missing. Run npm install first.');
    process.exit(2);
  }
  const logs = path.join(root, 'logs', 'service');
  mkdirSync(logs, { recursive: true });
  return new nw.Service({
    name: NAME,
    description: 'Screen-time rules for the Roku TV, and the parent dashboard (Roku TV Parental Control).',
    script,
    execPath: process.execPath,
    nodeOptions: ['--enable-source-maps'],
    workingDirectory: root,
    // Restart after a crash: 2 s, then 3 s, 4.5 s… at most 5 times a minute.
    wait: 2,
    grow: 0.5,
    maxRestarts: 5,
    // Stop by asking the process to shut down (IPC "shutdown"), not by killing it.
    stopparentfirst: true,
    stoptimeout: 20,
    logpath: logs,
    env: [
      { name: 'ROKU_GUARDIAN_SERVICE', value: '1' },
      { name: 'NODE_ENV', value: 'production' },
    ],
  });
}

function install(): void {
  windowsOnly();
  if (!existsSync(built)) {
    console.error(`Not built yet (${built} is missing). Run: npm run build`);
    process.exit(1);
  }
  requireAdmin('Installing the service');
  removeLegacyServices();
  const svc = service();
  if (svc.exists) {
    console.log(`The ${NAME} service is already installed (${state()}). After a rebuild: npm run service:restart`);
    return;
  }
  svc.on('install', () => {
    console.log(c('green', `✓ Installed the "${NAME}" Windows service. Starting it…`));
    harden();
    net('start');
    console.log(
      dim(
        [
          '  It now starts with Windows (a minute or two after boot, before anyone logs in), and restarts if it stops.',
          '  Check it:  npm run service:status      Logs: logs/roku-guardian.log',
          '  Stop "npm run dev" if it is still running: only one copy controls the TV at a time.',
        ].join('\n'),
      ),
    );
  });
  svc.on('alreadyinstalled', () => console.log('Already installed.'));
  svc.on('invalidinstallation', () =>
    console.error('A broken earlier installation was found. Run npm run service:uninstall, then install again.'),
  );
  svc.on('error', (err) => console.error(c('red', `✗ ${String(err)}`)));
  svc.install();
}

function uninstall(): void {
  windowsOnly();
  requireAdmin('Removing the service');
  removeLegacyServices();
  const svc = service();
  if (!svc.exists && state() === 'not installed') {
    console.log('The service is not installed.');
    return;
  }
  svc.on('uninstall', () =>
    console.log(c('green', `✓ Removed the "${NAME}" service.`) + dim(' Your data, logs and settings are untouched.')),
  );
  svc.on('alreadyuninstalled', () => console.log('The service is not installed.'));
  svc.on('error', (err) => console.error(c('red', `✗ ${String(err)}`)));
  svc.uninstall();
}

/** Is the app itself up, not just the Windows service around it? */
function probe(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString()));
      res.on('end', () => {
        try {
          resolve((JSON.parse(body) as { version?: string }).version ?? '?');
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

async function status(): Promise<void> {
  windowsOnly();
  const s = state();
  const color = s === 'running' ? 'green' : s === 'not installed' ? 'yellow' : 'red';
  console.log(`${NAME} service: ${c(color, s)}`);
  if (s === 'not installed') {
    console.log(dim('  Install it with: npm run service:install   (as administrator)'));
    return;
  }

  const config = loadConfig();
  const url = `http://localhost:${config.http.port}`;
  const version = await probe(config.http.port);
  const lastSeen = withRepos(config, (r) => r.runtime.get('live')?.updatedAt ?? null);
  const seen = lastSeen ? formatLocal(lastSeen, config.timezone, 'ccc MMM d, h:mm:ss a') : 'never';
  if (version) {
    console.log(
      `Roku TV Parental Control ${version}: ${c('green', 'answering')} at ${url}   ${dim(`(last check of the TV: ${seen})`)}`,
    );
  } else {
    console.log(
      `Roku TV Parental Control: ${c('red', 'not answering')} at ${url}   ${dim(`(last sign of life: ${seen})`)}`,
    );
    console.log(
      dim(
        [
          s === 'running'
            ? '  The service is running but the app inside it isn’t. Restart it: npm run service:restart (as administrator).'
            : '  Start it: npm run service:start (as administrator).',
          '  What happened at start-up: logs/service/launcher.log   App log: logs/roku-guardian.log',
        ].join('\n'),
      ),
    );
  }
  console.log(dim(`  Windows name: ${SERVICE_ID}   Wrapper logs: logs/service/`));
}

const command = process.argv[2];
switch (command) {
  case 'install':
    install();
    break;
  case 'uninstall':
    uninstall();
    break;
  case 'start':
  case 'stop':
    windowsOnly();
    requireAdmin(`${command === 'start' ? 'Starting' : 'Stopping'} the service`);
    if (command === 'start') harden();
    net(command);
    break;
  case 'restart':
    windowsOnly();
    requireAdmin('Restarting the service');
    harden();
    net('stop');
    net('start');
    break;
  case 'ensure':
    // The installer: install it, or (re)start the installed one with the current settings.
    windowsOnly();
    requireAdmin('Setting up the service');
    removeLegacyServices();
    if (state() === 'not installed') {
      install();
    } else {
      harden();
      net('stop');
      net('start');
    }
    break;
  case 'status':
    await status();
    break;
  default:
    console.error(
      'Usage: npm run service:install | service:uninstall | service:start | service:stop | service:restart | service:status\n' +
        '       (node dist/src/cli/service.js ensure: install or restart, for the Windows installer)',
    );
    process.exit(2);
}
