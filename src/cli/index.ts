import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from '../config/load.js';
import type { Config } from '../config/schema.js';
import { openDatabase } from '../db/database.js';
import { createRepos, type Repos } from '../db/repo.js';
import { EcpClient } from '../ecp/client.js';
import { lanUrls, listIPv4Interfaces, scanSubnet, ssdpDiscover, type DiscoveredDevice } from '../ecp/discovery.js';
import { isEcpError, type ActiveApp, type DeviceInfo } from '../ecp/types.js';
import { createCliLogger } from '../lib/logger.js';
import { formatAgo, formatDuration, formatLocal } from '../lib/time.js';
import { classifyActiveApp, type Observation } from '../monitor/observation.js';
import type { LiveStatus } from '../monitor/status.js';
import { SETTINGS_HINT } from '../monitor/status.js';
import { UsageService } from '../usage/usage.js';
import {
  appsCommand,
  bonusCommand,
  eventsCommand,
  lockCommand,
  pauseCommand,
  resumeCommand,
  rulesView,
  setPinCommand,
} from './controls.js';
import { bar, bold, c, dim, kv, table } from './format.js';
import { backupCommand, channelBuildCommand, channelInstallCommand, messageCommand } from './ops.js';
import { printPhoneLink, setupCommand } from './setup.js';
import { windowsServiceState } from './winservice.js';

const HELP = `Roku TV Parental Control CLI

Usage: npm run <command> [-- options]      (or: tsx src/cli/index.ts <command> [options])

Getting started
  setup              The setup wizard: finds the TV, sets the PIN and first rules, installs the message channel
  phone              Show the dashboard's address and a QR code to open it on a phone

Commands
  status             Live TV state, health, today's screen time, rules and what they'd do now
  discover           Find Rokus on the network (SSDP, then subnet scan with --scan)
  sessions           Recent sessions
  apps               Installed apps/inputs with their ids and current rule
  events             Event log: enforcement actions, health changes, overrides (--type enforcement)

Parent controls (take effect within one poll, ~5 s)
  pause [minutes]    "Parent is watching": no enforcement (until resumed if no minutes)
  resume             End a pause or lock
  lock [minutes]     Turn the TV off now and keep it off (until unlocked if no minutes)
  unlock             Same as resume
  bonus <minutes>    Add bonus time for today (negative to take it back)

Dashboard
  set-pin <digits>   Create or change the dashboard PIN (4–12 digits; only possible on this PC)

TV messages (the Parental Control channel, README §12)
  channel:build      Package the channel into roku-channel/out/parental-control-channel.zip
  channel:install    Install it on the TV (developer mode; password from ROKU_DEV_PASSWORD or --password)
  message "<text>"   Show a message on the TV now (--test for a sample)

Maintenance
  backup             Back up the database now and list backups (--list: only list)

Options
  -c, --config <path>   config file (default: ./config.json)
      --json            machine-readable output (status, discover, sessions, apps, events)
      --scan            discover: also probe port 8060 across the local subnet
  -n, --limit <n>       sessions/events: how many (default 20)
      --type <type>     events: only this type (enforcement, health, device, override, service, config, message)
      --host <ip>       setup / channel:install / message: the TV's address (default: the TV the service found)
      --password <pw>   channel:install: the TV's developer password
  -y, --yes             setup: take every suggestion without asking
`;

// Piping into `head`/`more` closes stdout early — exit quietly instead of crashing.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      json: { type: 'boolean', default: false },
      scan: { type: 'boolean', default: false },
      limit: { type: 'string', short: 'n', default: '20' },
      type: { type: 'string' },
      host: { type: 'string' },
      password: { type: 'string' },
      port: { type: 'string' },
      test: { type: 'boolean', default: false },
      list: { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      installer: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const command = positionals[0];
  if (!command || values.help) {
    console.log(HELP);
    return;
  }

  let config: Config;
  try {
    config = loadConfig(values.config ? { configPath: values.config } : {});
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }

  switch (command) {
    case 'setup':
      return setupCommand(config, {
        yes: values.yes,
        installer: values.installer,
        ...(values.host ? { host: values.host } : {}),
        ...(values.port ? { installerPort: Number(values.port) } : {}),
      });
    case 'phone':
      return printPhoneLink(config.http.port);
    case 'status':
      return statusCommand(config, values.json);
    case 'discover':
      return discoverCommand(config, { json: values.json, scan: values.scan });
    case 'sessions':
      return sessionsCommand(config, { json: values.json, limit: Number(values.limit) || 20 });
    case 'apps':
      return appsCommand(config, values.json);
    case 'events':
      return eventsCommand(config, {
        json: values.json,
        limit: Number(values.limit) || 20,
        ...(values.type ? { type: values.type } : {}),
      });
    case 'pause':
      return pauseCommand(config, positionals[1]);
    case 'resume':
    case 'unlock':
      return resumeCommand(config);
    case 'lock':
      return lockCommand(config, positionals[1]);
    case 'bonus':
      return bonusCommand(config, positionals[1]);
    case 'set-pin':
      return setPinCommand(config, positionals[1]);
    case 'channel:build':
      return channelBuildCommand();
    case 'channel:install':
      return channelInstallCommand(config, {
        ...(values.host ? { host: values.host } : {}),
        ...(values.password ? { password: values.password } : {}),
        ...(values.port ? { port: values.port } : {}),
      });
    case 'message':
      return messageCommand(config, positionals.slice(1).join(' '), {
        test: values.test,
        ...(values.host ? { host: values.host } : {}),
      });
    case 'backup':
      return backupCommand(config, values.list);
    default:
      console.error(`Unknown command "${command}".\n`);
      console.log(HELP);
      process.exit(2);
  }
}

// ─── status ─────────────────────────────────────────────────────────────────

interface LiveQuery {
  info?: DeviceInfo;
  active?: ActiveApp;
  error?: string;
  restricted?: boolean;
}

/** Query device-info, then active-app; keeps whatever succeeded and reports the first refusal. */
async function queryTv(host: string, port: number, timeoutMs: number): Promise<LiveQuery> {
  const client = new EcpClient({ host, port, timeoutMs });
  const fail = (err: unknown, partial: Partial<LiveQuery> = {}): LiveQuery => ({
    ...partial,
    error: (err as Error).message,
    restricted: isEcpError(err, 'restricted') || isEcpError(err, 'refused'),
  });
  let info: DeviceInfo;
  try {
    info = await client.deviceInfo();
  } catch (err) {
    return fail(err);
  }
  if (info.powerMode !== 'PowerOn') return { info };
  try {
    return { info, active: await client.activeApp() };
  } catch (err) {
    return fail(err, { info });
  }
}

const HEALTH_STYLE: Record<string, Parameters<typeof c>[0]> = {
  online: 'green',
  tv_off: 'cyan',
  starting: 'gray',
  searching: 'yellow',
  offline: 'yellow',
  restricted: 'red',
};

async function statusCommand(config: Config, json: boolean): Promise<void> {
  const db = openDatabase(config.database.path, { logger: createCliLogger() });
  const repos = createRepos(db);
  const now = Date.now();
  const zone = config.timezone;

  const pinned = config.device.serial ? repos.devices.get(config.device.serial) : repos.devices.pinned();
  const host = config.device.host ?? pinned?.host ?? null;
  const port = config.device.host ? config.device.port : (pinned?.port ?? config.device.port);
  const live = host ? await queryTv(host, port, config.monitor.requestTimeoutMs) : null;

  const svc = repos.runtime.get<LiveStatus & { pid?: number; stoppedAt?: number }>('live');
  const service = repos.runtime.get<{ version: string; startedAt: number; pid: number }>('service');
  const usage = new UsageService(repos.sessions, zone, config.usage.excludeAppIds).forDay(now);
  const open = repos.sessions.getOpen();
  const override = repos.overrides.get();
  const bonus = repos.overrides.bonusFor(usage.range.day);
  const channel = repos.apps.list({ installedOnly: true }).find((a) => a.appId === config.tvMessages.appId);
  db.close();

  const serialForObs = live?.info?.serialNumber ?? pinned?.serial ?? 'tv';
  const observation: Observation = live?.info
    ? live.info.powerMode !== 'PowerOn'
      ? { status: 'off', deviceSerial: serialForObs, powerMode: live.info.powerMode }
      : live.active
        ? classifyActiveApp(live.active, serialForObs)
        : { status: 'unknown', reason: live.restricted ? 'restricted' : 'unreachable' }
    : { status: 'unknown', reason: live?.restricted ? 'restricted' : 'unreachable' };
  const rules = rulesView(config, { observation, usage, override, bonus, now });

  const staleAfter = Math.max(30_000, config.monitor.pollIntervalSec * 1000 * 4, (svc?.value.pollIntervalMs ?? 0) * 2);
  const serviceRunning = Boolean(svc && !svc.value.stoppedAt && now - svc.updatedAt < staleAfter);

  if (json) {
    console.log(
      JSON.stringify(
        {
          now,
          timezone: zone,
          service: {
            running: serviceRunning,
            lastPollAt: svc?.updatedAt ?? null,
            status: svc?.value ?? null,
            ...(service?.value ?? {}),
          },
          device: pinned,
          live,
          openSession: open,
          today: usage,
          enforcement: config.enforcement.mode,
          override,
          bonusMinutes: bonus,
          decision: rules.decision,
        },
        null,
        2,
      ),
    );
    return;
  }

  const out: string[] = [];
  out.push(`${bold('Roku TV Parental Control')}  ${dim(formatLocal(now, zone))}`);
  out.push('');

  // Service
  const svcLine = serviceRunning
    ? `${c('green', '● running')}  ${dim(`last poll ${formatAgo(svc!.updatedAt, now)}${service ? ` · v${service.value.version} · pid ${service.value.pid}` : ''}`)}`
    : svc
      ? `${c('yellow', '○ not running')}  ${dim(`last poll ${formatAgo(svc.updatedAt, now)}`)}`
      : `${c('yellow', '○ never run')}  ${dim('start it with: npm run dev')}`;
  const rows: Array<[string, string]> = [['Service', svcLine]];
  const winService = windowsServiceState();
  if (winService) {
    rows.push([
      'Windows service',
      winService === 'running'
        ? c('green', 'running')
        : winService === 'not installed'
          ? dim('not installed (npm run service:install, as administrator)')
          : c('yellow', winService),
    ]);
  }
  rows.push([
    'TV messages',
    !config.tvMessages.enabled
      ? dim('off (tvMessages.enabled)')
      : channel
        ? `${c('green', 'channel installed')}${channel.version ? dim(` v${channel.version}`) : ''}`
        : dim('channel not installed (npm run channel:install, README §12)'),
  ]);
  if (svc && serviceRunning) {
    const h = svc.value.health;
    rows.push(['Health', `${c(HEALTH_STYLE[h] ?? 'white', h.toUpperCase().replace('_', ' '))}  ${svc.value.message}`]);
    if (svc.value.lastError && h !== 'online' && h !== 'tv_off') rows.push(['Detail', dim(svc.value.lastError)]);
    if (config.http.enabled)
      rows.push(['Dashboard', `${lanUrls(config.http.port)[0] ?? `http://localhost:${config.http.port}/`}`]);
  }

  // TV
  if (!host) {
    rows.push(['TV', c('yellow', 'not pinned yet — run `npm run discover`, or set device.host in config.json')]);
  } else {
    const name = live?.info?.name ?? pinned?.name ?? 'Roku TV';
    const serial = live?.info?.serialNumber ?? pinned?.serial ?? '?';
    rows.push([
      'TV',
      `${bold(name)}  ${dim([live?.info?.modelName ?? pinned?.model, `serial ${serial}`, `${host}:${port}`].filter(Boolean).join(' · '))}`,
    ]);
    if (live?.info) {
      rows.push([
        'Power',
        live.info.powerMode === 'PowerOn' ? c('green', 'PowerOn') : c('cyan', live.info.powerMode ?? 'unknown'),
      ]);
      if (live.active) {
        const a = classifyActiveApp(live.active, serial);
        const since =
          open && open.appId === a.appId && open.kind === a.kind
            ? dim(` · since ${formatLocal(open.startedAt, zone, 'h:mm a')} (${formatDuration(now - open.startedAt)})`)
            : '';
        rows.push([
          'Showing',
          `${a.kind === 'app' ? bold(a.appName) : a.appName}${a.appId ? dim(` (${a.appId})`) : ''}${since}`,
        ]);
      }
    } else if (live?.error) {
      rows.push(['Live', c(live.restricted ? 'red' : 'yellow', live.error)]);
      if (live.restricted) rows.push(['', dim(SETTINGS_HINT)]);
    }
  }
  out.push(kv([...rows, ...rules.rows]));
  out.push('');

  // Today
  const max = Math.max(1, ...usage.byApp.map((a) => a.ms));
  out.push(
    `${bold('Today')} ${dim(usage.range.day)}   screen time ${bold(formatDuration(usage.screenMs))}   ${dim(`home ${formatDuration(usage.homeMs)} · screensaver ${formatDuration(usage.screensaverMs)}`)}`,
  );
  if (usage.byApp.length) {
    out.push(
      table(
        ['App', 'Time', ''],
        usage.byApp.map((a) => [a.appName, formatDuration(a.ms), bar(a.ms / max)]),
      ),
    );
  } else {
    out.push(dim('  no screen time recorded today'));
  }
  console.log(out.join('\n'));
}

// ─── discover ───────────────────────────────────────────────────────────────

async function discoverCommand(config: Config, opts: { json: boolean; scan: boolean }): Promise<void> {
  const logger = createCliLogger();
  const ifaces = listIPv4Interfaces(config.discovery.interfaces);
  if (!opts.json) {
    console.log(
      `${bold('Searching')} via SSDP on ${ifaces.map((i) => `${i.address} (${i.name})`).join(', ') || 'no interfaces'}…`,
    );
  }
  const found = new Map<string, DiscoveredDevice>();
  for (const d of await ssdpDiscover({
    timeoutMs: config.discovery.ssdpTimeoutMs,
    ...(config.discovery.interfaces ? { interfaces: config.discovery.interfaces } : {}),
    logger,
  })) {
    found.set(d.serial ?? `${d.host}:${d.port}`, d);
  }
  if (opts.scan || found.size === 0) {
    if (!opts.json)
      console.log(
        `${bold('Scanning')} port ${config.device.port} on the local subnet${found.size === 0 ? ' (SSDP found nothing)' : ''}…`,
      );
    for (const d of await scanSubnet({
      port: config.device.port,
      timeoutMs: config.discovery.scanTimeoutMs,
      concurrency: config.discovery.scanConcurrency,
      ...(config.discovery.interfaces ? { interfaces: config.discovery.interfaces } : {}),
      logger,
    })) {
      const key = d.serial ?? `${d.host}:${d.port}`;
      found.set(key, { ...d, ...found.get(key) });
    }
  }

  // Enrich SSDP results with device-info.
  const devices = await Promise.all(
    [...found.values()].map(async (d) => {
      if (d.name) return d;
      const live = await queryTv(d.host, d.port, config.monitor.requestTimeoutMs);
      const base = live.info
        ? {
            ...d,
            serial: d.serial ?? live.info.serialNumber,
            name: live.info.name,
            model: live.info.modelName,
            powerMode: live.info.powerMode,
          }
        : { ...d, name: live.restricted ? '(ECP restricted)' : '(no device-info)' };
      return { ...base, ...(live.error ? { error: live.error, restricted: live.restricted ?? false } : {}) };
    }),
  );

  if (opts.json) {
    console.log(JSON.stringify(devices, null, 2));
    return;
  }
  if (!devices.length) {
    console.log(c('yellow', '\nNo Roku found.'));
    console.log(dim('  • Is the PC on the same network/VLAN as the TV (not a guest Wi-Fi)?'));
    console.log(dim(`  • ${SETTINGS_HINT}`));
    console.log(
      dim('  • Allow node.exe through Windows Firewall (private networks), or set device.host in config.json.'),
    );
    process.exitCode = 1;
    return;
  }
  console.log('');
  console.log(
    table(
      ['Serial', 'Name', 'Model', 'Address', 'Power', 'Via'],
      devices.map((d) => [
        bold(d.serial ?? '?'),
        d.name ?? '',
        d.model ?? '',
        `${d.host}:${d.port}`,
        d.powerMode ?? '',
        d.via,
      ]),
    ),
  );
  const problems = devices.filter((d): d is typeof d & { error: string } => 'error' in d && Boolean(d.error));
  if (problems.length) {
    console.log('');
    for (const d of problems) console.log(c('red', `  ${d.serial ?? `${d.host}:${d.port}`}: ${d.error}`));
    if (problems.some((d) => 'restricted' in d && d.restricted)) console.log(c('yellow', `  → ${SETTINGS_HINT}`));
  }
  console.log(
    dim(
      `\nPin one by setting "device": { "serial": "<Serial>" } in config.json (the service auto-pins if there is only one).`,
    ),
  );
}

// ─── sessions ───────────────────────────────────────────────────────────────

function sessionsCommand(config: Config, opts: { json: boolean; limit: number }): void {
  const db = openDatabase(config.database.path, { logger: createCliLogger() });
  const repos: Repos = createRepos(db);
  const rows = repos.sessions.recent(opts.limit);
  db.close();
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (!rows.length) {
    console.log(dim('No sessions recorded yet.'));
    return;
  }
  const zone = config.timezone;
  console.log(
    table(
      ['Start', 'End', 'Duration', 'Kind', 'App', 'Ended by'],
      rows.map((s) => [
        formatLocal(s.startedAt, zone, 'LLL d h:mm:ss a'),
        s.endedAt ? formatLocal(s.endedAt, zone, 'h:mm:ss a') : c('green', 'open'),
        formatDuration(s.durationMs),
        s.kind,
        s.kind === 'app' ? bold(s.appName ?? s.appId ?? '') : (s.appName ?? ''),
        s.endReason ?? '',
      ]),
    ),
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
