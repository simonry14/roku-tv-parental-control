import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { AuthService, PIN_PATTERN } from '../api/auth.js';
import { buildChannelPackage, channelVersion } from '../channel/package.js';
import { SideloadError, sideloadChannel } from '../channel/sideload.js';
import type { Config } from '../config/schema.js';
import { openDatabase } from '../db/database.js';
import { createRepos, type Repos } from '../db/repo.js';
import { EcpClient } from '../ecp/client.js';
import { lanUrls, scanSubnet, ssdpDiscover } from '../ecp/discovery.js';
import { isEcpError, type DeviceInfo, type EcpKey } from '../ecp/types.js';
import { createCliLogger } from '../lib/logger.js';
import { projectRoot } from '../lib/paths.js';
import { systemClock } from '../lib/time.js';
import { bold, c, dim } from './format.js';
import { clock12, parseClockInput, parseHoursInput, Prompter } from './prompt.js';

/**
 * `setup`: the first-run wizard (scripts/windows/install.ps1 runs it). Five steps, each skipped
 * when it's already done, so running it again (or an update) only asks what's missing:
 *   1 time zone (from this PC)   2 the TV (find it, check "Control by mobile apps")
 *   3 dashboard PIN              4 starting rules (written to config.json)
 *   5 messages on the TV (developer mode + the channel, optional)
 * Everything it writes can be changed later in the dashboard.
 */

export interface SetupOptions {
  /** Take every default without asking (tests, unattended installs). */
  yes: boolean;
  /** Run by the Windows installer: it shows the phone link itself once the service is up. */
  installer: boolean;
  /** Skip discovery and use this TV address. */
  host?: string;
  /** The TV's developer web installer port (80 on a real TV; tests use the mock's). */
  installerPort?: number;
  /** Where answers come from and output goes (tests). */
  io?: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream };
  /** The .env file for the developer password (default: the project's). */
  envFile?: string;
}

interface Tv {
  host: string;
  port: number;
  serial: string | null;
  name: string;
}

type ConfigFile = Record<string, unknown> & {
  timezone?: string;
  device?: Record<string, unknown>;
  rules?: Record<string, unknown>;
  enforcement?: Record<string, unknown>;
};

const STEPS = 5;
/** How to get back here: the installer adds a Start menu shortcut for it. */
const AGAIN_INSTALLED = 'Start menu → Roku TV Parental Control → Run setup again';
const AGAIN_DEV = 'npm run setup';
const DEV_MODE_KEYS: EcpKey[] = ['Home', 'Home', 'Home', 'Up', 'Up', 'Right', 'Left', 'Right', 'Left', 'Right'];
const TV_SETTING =
  'On the TV, with the remote: Home → Settings → System → Advanced system settings → Control by mobile apps → Network access → “Enabled”.';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function setupCommand(config: Config, opts: SetupOptions): Promise<void> {
  const ui = new Prompter({ assumeDefaults: opts.yes, ...(opts.io ?? {}) });
  const out = (s = ''): void => void ui.output.write(`${s}\n`);
  // Inside the installer (its own "Step 6 of 8"), the wizard's steps are numbered as parts of it.
  const step = (n: number, title: string, optional = false): void => {
    out('');
    out(
      bold(
        opts.installer
          ? `  ${title} (${n} of ${STEPS}${optional ? ', optional' : ''})`
          : `Step ${n} of ${STEPS}: ${title}${optional ? ' (optional)' : ''}`,
      ),
    );
  };
  const again = opts.installer ? AGAIN_INSTALLED : AGAIN_DEV;
  // The installer's console window may use a font without ✓ (Windows 10 conhost), so it gets plain OK.
  const ok = (s: string): void => out(opts.installer ? `  ${c('green', 'OK')}  ${s}` : `  ${c('green', '✓')} ${s}`);
  const note = (s: string): void => out(dim(`  ${s}`));
  const warn = (s: string): void => out(`  ${c('yellow', '!')} ${s}`);

  const db = openDatabase(config.database.path, { logger: createCliLogger() });
  const repos = createRepos(db);
  const file = readConfigFile(config.configPath);
  let tv: Tv | null;

  try {
    if (opts.installer) {
      out(dim('  Five short questions. Press Enter to accept the suggestion in [brackets].'));
    } else {
      out('');
      out(bold('Roku TV Parental Control: setup'));
      out(dim('Five short steps. Press Enter to accept the suggestion in [brackets].'));
    }

    // ─── 1. Time zone ──────────────────────────────────────────────────────
    step(1, 'Your time zone');
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (file.timezone && file.timezone !== detected) {
      const keep = await ui.confirm(`  Keep the time zone ${file.timezone}? (This PC says ${detected}.)`, true);
      if (!keep) file.timezone = detected;
    } else {
      file.timezone = detected;
    }
    ok(`Times follow ${file.timezone}.`);

    // ─── 2. The TV ─────────────────────────────────────────────────────────
    step(2, 'Your Roku TV');
    tv = await chooseTv(ui, config, file, repos, opts, { out, ok, note, warn });
    if (tv) {
      await checkAccess(ui, tv, config, { out, ok, note, warn });
      // Once the TV answers, it can say its name and serial (it can't while it's refusing).
      const { info } = await describe(tv.host, tv.port, config.monitor.requestTimeoutMs);
      if (info) tv = { ...tv, name: info.name ?? tv.name, serial: info.serialNumber ?? tv.serial };
      file.device = { ...(file.device ?? {}), serial: tv.serial ?? '' };
      if (!tv.serial) file.device.host = tv.host;
    } else {
      warn('Skipped. Roku TV Parental Control keeps looking for a Roku TV on its own once it runs.');
    }

    // ─── 3. PIN ────────────────────────────────────────────────────────────
    step(3, 'A PIN for the dashboard');
    const auth = new AuthService(db, repos.settings, { sessionDays: config.http.sessionDays }, systemClock);
    if (auth.isPinSet() && (await ui.confirm('  A PIN is already set. Keep it?', true))) {
      ok('Keeping your PIN.');
    } else {
      note('You type this PIN on your phone or PC to change the rules. Keep it from the kids.');
      const pin = await askPin(ui, { out, warn });
      if (pin) {
        await auth.setPin(pin);
        repos.events.add({ at: Date.now(), type: 'auth', severity: 'warn', message: 'Dashboard PIN set (setup)' });
        ok('PIN saved.');
      } else {
        warn(`No PIN yet. Set one later: ${opts.installer ? AGAIN_INSTALLED : 'npm run set-pin -- <digits>'}.`);
      }
    }

    // ─── 4. Rules ──────────────────────────────────────────────────────────
    step(4, 'Rules to start with');
    await chooseRules(ui, file, repos, { out, ok, note, warn });
    writeConfigFile(config.configPath, file);
    note(`Saved in ${config.configPath}`);

    // ─── 5. Messages on the TV ─────────────────────────────────────────────
    step(5, 'Messages on the TV', true);
    if (!tv) {
      note(`Skipped: no TV yet. Once the TV is found, run setup again (${again}).`);
    } else {
      await setUpChannel(ui, tv, config, repos, opts, { out, ok, note, warn });
    }

    // ─── Done ──────────────────────────────────────────────────────────────
    out('');
    out(c('green', bold('Setup is complete.')));
    if (!opts.installer) await printPhoneLink(config.http.port, out);
    else out(dim('Starting Roku TV Parental Control…'));
  } finally {
    db.close();
    ui.close();
  }
}

interface Say {
  out(s?: string): void;
  ok(s: string): void;
  note(s: string): void;
  warn(s: string): void;
}

// ─── TV ─────────────────────────────────────────────────────────────────────

/** "Living Room TV (192.168.1.162)", or "a Roku at 192.168.1.162" while the TV won't say its name. */
const label = (tv: Tv): string => (tv.name.includes(tv.host) ? tv.name : `${bold(tv.name)} (${tv.host})`);

async function describe(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ info?: DeviceInfo; blocked: boolean }> {
  try {
    return { info: await new EcpClient({ host, port, timeoutMs }).deviceInfo(), blocked: false };
  } catch (err) {
    return { blocked: isEcpError(err, 'restricted') };
  }
}

async function findTvs(config: Config, say: Say): Promise<Tv[]> {
  say.note('Looking for Roku TVs on your Wi-Fi…');
  const logger = createCliLogger();
  const found = new Map<string, { host: string; port: number; serial: string | null }>();
  for (const d of await ssdpDiscover({ timeoutMs: config.discovery.ssdpTimeoutMs, logger })) {
    found.set(d.serial ?? `${d.host}:${d.port}`, d);
  }
  if (found.size === 0) {
    say.note('Checking every address on the network (this takes a little longer)…');
    for (const d of await scanSubnet({
      port: config.device.port,
      timeoutMs: config.discovery.scanTimeoutMs,
      concurrency: config.discovery.scanConcurrency,
      logger,
    })) {
      found.set(d.serial ?? `${d.host}:${d.port}`, d);
    }
  }
  return Promise.all(
    [...found.values()].map(async (d) => {
      const { info } = await describe(d.host, d.port, config.monitor.requestTimeoutMs);
      return {
        host: d.host,
        port: d.port,
        serial: info?.serialNumber ?? d.serial,
        name: info?.name ?? `a Roku at ${d.host}`,
      };
    }),
  );
}

async function chooseTv(
  ui: Prompter,
  config: Config,
  file: ConfigFile,
  repos: Repos,
  opts: SetupOptions,
  say: Say,
): Promise<Tv | null> {
  const port = config.device.port;
  // An address given on the command line, or the TV chosen before (where the service last saw it).
  const knownHost =
    opts.host ??
    (typeof file.device?.host === 'string' && file.device.host ? file.device.host : null) ??
    (config.device.serial ? (repos.devices.get(config.device.serial)?.host ?? null) : null);
  if (knownHost) {
    const { info } = await describe(knownHost, port, config.monitor.requestTimeoutMs);
    const tv: Tv = {
      host: knownHost,
      port,
      serial: info?.serialNumber ?? config.device.serial ?? null,
      name: info?.name ?? `a Roku at ${knownHost}`,
    };
    if (opts.host || (await ui.confirm(`  Use ${label(tv)}?`, true))) {
      say.ok(`Using ${label(tv)}.`);
      return tv;
    }
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const tvs = await findTvs(config, say);
    if (tvs.length === 1) {
      const only = tvs[0]!;
      if (await ui.confirm(`  Found ${label(only)}. Is this the TV to control?`, true)) {
        say.ok(`Using ${label(only)}.`);
        return only;
      }
    } else if (tvs.length > 1) {
      say.out('  Found these Roku devices:');
      tvs.forEach((t, i) => say.out(`    ${i + 1}. ${label(t)}`));
      for (;;) {
        const pick = Number(await ui.ask('  Which one should be controlled? Type its number', '1'));
        if (Number.isInteger(pick) && pick >= 1 && pick <= tvs.length) {
          const t = tvs[pick - 1]!;
          say.ok(`Using ${label(t)}.`);
          return t;
        }
        say.warn(`Type a number from 1 to ${tvs.length}.`);
      }
    } else {
      say.warn('No Roku TV found yet.');
      say.note('Check that the TV is switched on and on the same Wi-Fi as this PC (not a guest network).');
    }
    if (ui.exhausted) return null;
    const answer = await ui.ask(
      '  Press Enter to look again, type the TV’s IP address (TV: Settings → Network → About), or type skip',
    );
    if (answer.toLowerCase() === 'skip') return null;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(answer)) {
      const { info, blocked } = await describe(answer, port, config.monitor.requestTimeoutMs);
      if (info || blocked) {
        const t: Tv = {
          host: answer,
          port,
          serial: info?.serialNumber ?? null,
          name: info?.name ?? `a Roku at ${answer}`,
        };
        say.ok(`Using ${label(t)}.`);
        return t;
      }
      say.warn(`Nothing answered at ${answer}.`);
    }
  }
  return null;
}

/** "Control by mobile apps" must be Enabled: device-info works when it's Limited, icons don't. */
async function accessState(tv: Tv, timeoutMs: number): Promise<'ok' | 'blocked' | 'limited' | 'unreachable'> {
  const client = new EcpClient({ host: tv.host, port: tv.port, timeoutMs });
  try {
    await client.deviceInfo();
    const apps = await client.apps();
    const probe = apps.find((a) => a.type === 'appl');
    if (probe) await client.icon(probe.id);
    return 'ok';
  } catch (err) {
    if (isEcpError(err, 'restricted')) {
      // device-info itself refused = Disabled; refused later = Limited.
      try {
        await client.deviceInfo();
        return 'limited';
      } catch {
        return 'blocked';
      }
    }
    return 'unreachable';
  }
}

async function checkAccess(ui: Prompter, tv: Tv, config: Config, say: Say): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const state = await accessState(tv, config.monitor.requestTimeoutMs);
    if (state === 'ok') {
      say.ok('The TV accepts commands from this PC.');
      return;
    }
    if (state === 'unreachable') {
      say.warn('The TV didn’t answer just now (is it switched on?).');
    } else {
      say.warn('The TV isn’t accepting commands from this PC yet.');
      say.out(`    ${TV_SETTING}`);
      if (state === 'limited') say.note('It’s on “Limited” now, which only lets apps watch, not act.');
    }
    if (ui.exhausted) break;
    const answer = await ui.pause('  Press Enter once that’s done (or type skip)');
    if (answer === 'skip') break;
  }
  say.warn('Continuing without it. The dashboard will remind you until the TV setting is changed.');
}

// ─── PIN ────────────────────────────────────────────────────────────────────

async function askPin(ui: Prompter, say: Pick<Say, 'out' | 'warn'>): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const pin = await ui.secret('  Choose a PIN (4 to 12 digits): ');
    if (pin === null) return null;
    if (!PIN_PATTERN.test(pin)) {
      say.warn('Use 4 to 12 digits (6 is a good length), numbers only.');
      continue;
    }
    const again = await ui.secret('  Type it again: ');
    if (again === pin) return pin;
    say.warn('Those didn’t match. Let’s try again.');
  }
  return null;
}

// ─── Rules ──────────────────────────────────────────────────────────────────

async function chooseRules(ui: Prompter, file: ConfigFile, repos: Repos, say: Say): Promise<void> {
  if (repos.settings.get('overlay.rules')) {
    say.ok('Your rules are set in the dashboard already. Change them there (Rules).');
    return;
  }
  const rules: Record<string, unknown> = { ...(file.rules ?? {}) };
  const hasRules = Object.keys(rules).length > 0;
  if (hasRules && (await ui.confirm('  Keep the rules you already have?', true))) {
    say.ok('Keeping your rules.');
  } else {
    say.note('You can change all of this later in the dashboard, under Rules.');
    const weekday = await askHours(
      ui,
      '  Hours of TV a day on school days (Monday to Friday)? Type 0 for no limit',
      '2',
      say,
    );
    const weekend = await askHours(ui, '  And on Saturdays and Sundays?', '3', say);
    const off = await askClock(
      ui,
      '  Bedtime: when should the TV switch off at night? Type none for no bedtime',
      '8:30 PM',
      say,
    );
    let quiet: string[] = [];
    if (off) {
      const on = await askClock(ui, '  When can it come back on in the morning?', '7:00 AM', say);
      quiet = [`${off}-${on ?? '07:00'}`];
    }
    rules.globalBudget = { weekday, weekend };
    rules.quietHours = quiet;
    rules.exemptApps = Array.isArray(rules.exemptApps) ? rules.exemptApps : ['dev'];
    const limits =
      weekday === null && weekend === null
        ? 'no daily limit'
        : `${weekday === null ? 'no limit' : `${weekday / 60} h`} on school days, ${weekend === null ? 'no limit' : `${weekend / 60} h`} at weekends`;
    say.ok(`${limits}${off ? `; TV off from ${clock12(off)}` : '; no bedtime'}.`);
  }
  file.rules = rules;

  if (repos.settings.get('overlay.enforcement')) return;
  const mode = (file.enforcement?.mode as string | undefined) ?? 'dry-run';
  if (mode === 'enforce') {
    say.ok('The rules are switched on.');
    return;
  }
  say.out('');
  say.note('Practice mode: for the first day, nothing is switched off. Roku TV Parental Control only writes');
  say.note('down what it would have done, so you can check the rules (dashboard → History). Then choose');
  say.note('Enforce in the dashboard → Rules.');
  const practice = await ui.confirm('  Start in practice mode?', true);
  file.enforcement = { ...(file.enforcement ?? {}), mode: practice ? 'dry-run' : 'enforce' };
  say.ok(practice ? 'Practice mode is on.' : 'The rules are switched on.');
}

async function askHours(ui: Prompter, q: string, def: string, say: Say): Promise<number | null> {
  for (;;) {
    const v = parseHoursInput(await ui.ask(q, def));
    if (v !== undefined) return v;
    say.warn('Type a number of hours, like 2 or 1.5 (or 0 for no limit).');
  }
}

async function askClock(ui: Prompter, q: string, def: string, say: Say): Promise<string | null> {
  for (;;) {
    const a = await ui.ask(q, def);
    if (a.toLowerCase() === 'none') return null;
    const t = parseClockInput(a);
    if (t) return t;
    say.warn('Type a time like 8:30 PM or 20:30.');
  }
}

// ─── Messages on the TV ─────────────────────────────────────────────────────

async function setUpChannel(
  ui: Prompter,
  tv: Tv,
  config: Config,
  repos: Repos,
  opts: SetupOptions,
  say: Say,
): Promise<void> {
  const client = new EcpClient({ host: tv.host, port: tv.port, timeoutMs: config.monitor.requestTimeoutMs });
  const version = channelVersion();
  const installed = await client
    .apps()
    .then((apps) => apps.find((a) => a.id === config.tvMessages.appId) ?? null)
    .catch(() => null);
  let password = process.env.ROKU_DEV_PASSWORD ?? null;

  if (installed && sameVersion(installed.version, version)) {
    say.ok('The message channel is on the TV already.');
    return;
  }
  if (installed && password) {
    say.note('Updating the message channel on the TV…');
  } else {
    if (!installed) {
      say.note('With this, the TV explains itself (“Screen time’s up for today”) instead of just jumping');
      say.note('to the Home screen or switching off. It uses the TV’s developer mode and takes about 3 minutes.');
    }
    if (!(await ui.confirm(installed ? '  Update the message channel on the TV?' : '  Set it up now?', true))) {
      say.note(`Skipped. You can do it later: run setup again (${opts.installer ? AGAIN_INSTALLED : AGAIN_DEV}).`);
      return;
    }
    if (!installed) await openDeveloperMode(ui, client, say);
    password = await ui.ask('  Type the developer password you chose on the TV');
    if (!password) {
      say.warn(
        `No password, so the channel wasn’t installed. Run setup again when you have it (${opts.installer ? AGAIN_INSTALLED : AGAIN_DEV}).`,
      );
      return;
    }
    saveEnv('ROKU_DEV_PASSWORD', password, opts.envFile);
    process.env.ROKU_DEV_PASSWORD = password;
  }

  const zip = buildChannelPackage();
  const deadline = Date.now() + 4 * 60_000;
  let waitingNoted = false;
  for (let authTries = 0; ;) {
    try {
      const res = await sideloadChannel({ host: tv.host, port: opts.installerPort ?? 80, password: password!, zip });
      say.ok(
        res.status === 'installed'
          ? 'Installed. The TV shows “Parental Control is ready”: press OK on the remote to close it.'
          : 'The message channel is on the TV.',
      );
      break;
    } catch (err) {
      if (!(err instanceof SideloadError)) throw err;
      if (err.kind === 'unreachable' && Date.now() < deadline) {
        if (!waitingNoted) say.note('Waiting for the TV to restart in developer mode (up to 4 minutes)…');
        waitingNoted = true;
        await sleep(5000);
        continue;
      }
      if (err.kind === 'auth' && ++authTries < 3 && !ui.exhausted) {
        say.warn('The TV didn’t accept that password.');
        password = await ui.ask('  Type the developer password again');
        saveEnv('ROKU_DEV_PASSWORD', password, opts.envFile);
        continue;
      }
      if (err.kind === 'auth') {
        say.warn('The TV didn’t accept the developer password, so the message channel wasn’t installed.');
        say.note('Forgotten it? Open the TV’s developer settings again (Home three times, Up twice, Right, Left,');
        say.note('Right, Left, Right), choose “Disable installer”, then run setup again to choose a new password.');
      } else {
        say.warn(`The message channel wasn’t installed: ${err.message}`);
      }
      say.note(
        `Everything else works without it. To try again, run setup again (${opts.installer ? AGAIN_INSTALLED : AGAIN_DEV}).`,
      );
      return;
    }
  }

  // Let the service know right away (it would also notice within 15 minutes).
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const apps = await client.apps();
      if (apps.some((a) => a.id === config.tvMessages.appId)) {
        const now = Date.now();
        repos.apps.syncInstalled(apps, now);
        repos.events.add({
          at: now,
          type: 'service',
          severity: 'info',
          message: `Parental Control channel installed on the TV (v${version})`,
        });
        return;
      }
    } catch {
      // the TV is busy opening the channel
    }
    await sleep(1000);
  }
}

async function openDeveloperMode(ui: Prompter, client: EcpClient, say: Say): Promise<void> {
  say.out('');
  say.out('  First, the TV’s developer mode. Look at the TV: the remote buttons are pressed for you now.');
  try {
    for (const key of DEV_MODE_KEYS) {
      await client.keypress(key);
      await sleep(450);
    }
  } catch {
    say.warn('The buttons couldn’t be pressed from here.');
  }
  say.out('  The TV should now show “Developer settings”:');
  say.out('    • If it offers “Enable installer and restart”: choose it, accept the agreement,');
  say.out('      and choose a password (write it down). The TV then restarts.');
  say.out('    • If it offers “Disable installer” instead, developer mode is on already: press Back.');
  say.out('    • If nothing appeared, use the remote: Home three times, Up twice, then');
  say.out('      Right, Left, Right, Left, Right.');
  await ui.pause('  Press Enter when you’ve chosen the password');
}

function sameVersion(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  const norm = (v: string): string =>
    v
      .split('.')
      .map((n) => String(parseInt(n, 10) || 0))
      .join('.');
  return norm(a) === norm(b);
}

// ─── Files ──────────────────────────────────────────────────────────────────

function readConfigFile(file: string): ConfigFile {
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as ConfigFile;
}

function writeConfigFile(file: string, data: ConfigFile): void {
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

/** Set one KEY=value line in .env, keeping the rest. */
export function saveEnv(key: string, value: string, file: string = path.join(projectRoot(), '.env')): void {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : [];
  while (lines.length && lines.at(-1) === '') lines.pop();
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  writeFileSync(file, `${lines.join('\n')}\n`);
}

// ─── Phone link ─────────────────────────────────────────────────────────────

/** The dashboard's address on this PC and for a phone on the same Wi-Fi, with a QR code. */
export async function printPhoneLink(
  port: number,
  out: (s?: string) => void = (s = '') => console.log(s),
): Promise<void> {
  const phone = lanUrls(port)[0] ?? null;
  out('');
  out(`  ${bold('On this PC:')}  http://localhost:${port}/`);
  if (!phone) {
    out(dim('  (This PC isn’t on a network right now, so there’s no address for a phone.)'));
    return;
  }
  out(`  ${bold('On your phone:')} connect it to the same Wi-Fi, then point its camera at this code`);
  out(`  or type ${bold(phone)}`);
  out('');
  const qr = await QRCode.toString(phone, { type: 'terminal', small: true, margin: 2 });
  for (const line of qr.split('\n')) if (line.trim()) out(`    ${line}`);
  out('');
}
