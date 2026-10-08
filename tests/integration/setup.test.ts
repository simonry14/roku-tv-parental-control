import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthService } from '../../src/api/auth.js';
import { setupCommand } from '../../src/cli/setup.js';
import { parseConfig } from '../../src/config/load.js';
import { openDatabase } from '../../src/db/database.js';
import { createRepos } from '../../src/db/repo.js';
import { systemClock } from '../../src/lib/time.js';
import type { MockRoku } from '../../mock/mock-roku.js';
import { mockRoku } from '../helpers.js';

/** The setup wizard, answered by a script that waits for each question, against the mock TV. */

const mocks: MockRoku[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((m) => m.close()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.ROKU_DEV_PASSWORD;
});

type Answer = string | (() => string | Promise<string>);

/** Answers each expected question in order, as soon as it appears in the output. */
function script(steps: Array<[RegExp, Answer]>) {
  const input = new PassThrough();
  const output = new PassThrough();
  let transcript = '';
  let pending = '';
  let busy = false;
  output.on('data', (d: Buffer) => {
    transcript += d.toString();
    pending += d.toString();
    void next();
  });
  async function next(): Promise<void> {
    if (busy) return;
    const step = steps[0];
    if (!step || !step[0].test(pending)) return;
    busy = true;
    steps.shift();
    pending = '';
    const answer = typeof step[1] === 'function' ? await step[1]() : step[1];
    input.write(`${answer}\n`);
    busy = false;
    void next();
  }
  return { io: { input, output }, transcript: () => transcript, remaining: () => steps.map((s) => s[0].source) };
}

function workspace(config: object = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'setup-test-'));
  dirs.push(dir);
  const configPath = path.join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  return { dir, configPath };
}

describe('setup wizard', () => {
  it(
    'first run: finds the TV, waits for the TV setting, PIN, rules, developer mode and the channel',
    { timeout: 30_000 },
    async () => {
      const tv = await mockRoku({
        initial: { access: 'limited', devChannelInstalled: false },
        devInstaller: { port: 0, password: 'tvpass' },
      });
      mocks.push(tv);
      const ws = workspace();
      const config = parseConfig(
        {
          device: { port: tv.ecpPort },
          database: { path: 'data/test.db' },
          log: { level: 'silent', file: null },
          monitor: { requestTimeoutMs: 1000 },
        },
        { configPath: ws.configPath, baseDir: ws.dir },
      );
      const s = script([
        [/Press Enter once that’s done/, () => (tv.set({ access: 'enabled' }), '')],
        [/Choose a PIN/, '12'], // too short
        [/Choose a PIN/, '482913'],
        [/Type it again/, '482913'],
        [/school days/, '1.5'],
        [/Saturdays and Sundays/, ''],
        [/Bedtime/, '9pm'],
        [/morning/, '6:30 am'],
        [/practice mode\?/, 'n'],
        [/Set it up now\?/, ''],
        [/Press Enter when you’ve chosen the password/, ''],
        [/Type the developer password you chose/, 'nope'],
        [/Type the developer password again/, 'tvpass'],
      ]);

      await setupCommand(config, {
        yes: false,
        installer: true,
        host: '127.0.0.1',
        installerPort: tv.devInstallerPort!,
        io: s.io,
        envFile: path.join(ws.dir, '.env'),
      });

      const out = s.transcript();
      expect(s.remaining()).toEqual([]);
      expect(out).toMatch(/Using .*Living Room TV \(mock\)/);
      expect(out).toMatch(/Limited/);
      expect(out).toMatch(/Use 4 to 12 digits/);
      expect(out).toMatch(/1\.5 h on school days, 3 h at weekends; TV off from 9:00 PM/);
      expect(out).toMatch(/didn’t accept that password/);
      expect(out).toMatch(/Installed\. The TV shows “Parental Control is ready”/);

      // config.json
      expect(JSON.parse(readFileSync(ws.configPath, 'utf8'))).toEqual({
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        device: { serial: tv.state.serial },
        rules: { globalBudget: { weekday: 90, weekend: 180 }, quietHours: ['21:00-06:30'], exemptApps: ['dev'] },
        enforcement: { mode: 'enforce' },
      });
      // The developer password is in .env, the PIN in the database, the channel on the TV.
      expect(readFileSync(path.join(ws.dir, '.env'), 'utf8')).toBe('ROKU_DEV_PASSWORD=tvpass\n');
      const db = openDatabase(config.database.path);
      const repos = createRepos(db);
      const auth = new AuthService(db, repos.settings, { sessionDays: 30 }, systemClock);
      expect(auth.isPinSet()).toBe(true);
      expect(await auth.verifyPin('482913')).toBe(true);
      expect(repos.apps.list({ installedOnly: true }).some((a) => a.appId === 'dev')).toBe(true);
      db.close();
      // Developer mode was opened with the remote sequence.
      expect(tv.history.filter((h) => h.path.startsWith('/keypress/')).map((h) => h.path.slice(10))).toEqual([
        'Home',
        'Home',
        'Home',
        'Up',
        'Up',
        'Right',
        'Left',
        'Right',
        'Left',
        'Right',
      ]);
      expect(tv.state.devChannelInstalled).toBe(true);
    },
  );

  it('running it again keeps what is set and only asks the missing bits', async () => {
    const tv = await mockRoku({ initial: { devChannelInstalled: true } });
    mocks.push(tv);
    const ws = workspace({
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      device: { serial: tv.state.serial },
      rules: { globalBudget: 120 },
      enforcement: { mode: 'enforce' },
      http: { port: 18090 },
    });
    const config = parseConfig(
      {
        ...JSON.parse(readFileSync(ws.configPath, 'utf8')),
        device: { serial: tv.state.serial, port: tv.ecpPort },
        database: { path: 'data/test.db' },
        log: { level: 'silent', file: null },
      },
      { configPath: ws.configPath, baseDir: ws.dir },
    );
    // A PIN already exists.
    const db = openDatabase(config.database.path);
    const repos = createRepos(db);
    await new AuthService(db, repos.settings, { sessionDays: 30 }, systemClock).setPin('1234');
    db.close();

    const s = script([
      [/A PIN is already set\. Keep it\?/, ''],
      [/Keep the rules you already have\?/, ''],
      [/Update the message channel on the TV\?/, 'n'], // the mock has an older version
    ]);
    await setupCommand(config, { yes: false, installer: false, host: '127.0.0.1', io: s.io });
    const out = s.transcript();
    expect(s.remaining()).toEqual([]);
    expect(out).toMatch(/Keeping your PIN/);
    expect(out).toMatch(/Keeping your rules/);
    expect(out).toMatch(/The rules are switched on/);
    expect(out).toMatch(/Skipped\. You can do it later/);
    expect(out).toMatch(/On your phone/); // not run by the installer: the wizard shows the phone link
    expect(JSON.parse(readFileSync(ws.configPath, 'utf8')).rules).toEqual({ globalBudget: 120 });
  });
});
