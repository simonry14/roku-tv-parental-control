import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CHANNEL_DIR, buildChannelPackage, channelVersion } from '../channel/package.js';
import { SideloadError, sideloadChannel } from '../channel/sideload.js';
import type { Config } from '../config/schema.js';
import { openDatabase } from '../db/database.js';
import { createRepos } from '../db/repo.js';
import { EcpClient } from '../ecp/client.js';
import { isEcpError } from '../ecp/types.js';
import { parentMessage, testMessage, toChannelParams } from '../enforce/tv-messages.js';
import { createCliLogger } from '../lib/logger.js';
import { projectRoot } from '../lib/paths.js';
import { systemClock } from '../lib/time.js';
import { BackupService } from '../ops/backup.js';
import { RuntimeConfig } from '../settings/runtime.js';
import { pinnedAddress, withRepos } from './controls.js';
import { bold, c, dim, table } from './format.js';

/** Channel packaging/sideloading, TV messages and backups from the PC. */

const kb = (n: number): string => `${Math.max(1, Math.round(n / 1024))} KB`;

function tvAddress(config: Config, host: string | undefined): { host: string; port: number } {
  const known = withRepos(config, (r) => pinnedAddress(config, r));
  const address = host ? { host, port: config.device.port } : known;
  if (!address) {
    throw new Error(
      'The TV’s address isn’t known yet. Start the service once (npm run dev) so it finds the TV, or pass --host <tv-ip>.',
    );
  }
  return address;
}

export function channelBuildCommand(): void {
  const zip = buildChannelPackage();
  const out = path.join(projectRoot(), CHANNEL_DIR, 'out', 'parental-control-channel.zip');
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, zip);
  console.log(`${c('green', '✓')} Channel v${channelVersion()} packaged (${kb(zip.length)}): ${out}`);
  console.log(dim('   Install it with: npm run channel:install   (or upload it at http://<tv-ip>/ in a browser)'));
}

export async function channelInstallCommand(
  config: Config,
  opts: { host?: string; password?: string; port?: string },
): Promise<void> {
  const password = opts.password ?? process.env.ROKU_DEV_PASSWORD;
  if (!password) {
    throw new Error(
      [
        'The TV’s developer password is needed (you chose it when you turned on developer mode).',
        'Add it to the .env file in the project folder:   ROKU_DEV_PASSWORD=<password>',
        'or pass it once:                                 npm run channel:install -- --password <password>',
      ].join('\n'),
    );
  }
  const address = tvAddress(config, opts.host);
  const zip = buildChannelPackage();
  const version = channelVersion();
  console.log(`Installing the Parental Control channel v${version} (${kb(zip.length)}) on ${address.host}…`);

  try {
    const res = await sideloadChannel({
      host: address.host,
      port: opts.port ? Number(opts.port) : 80,
      password,
      zip,
    });
    console.log(
      res.status === 'installed'
        ? `${c('green', '✓')} Installed. The TV now shows “Parental Control is ready”; press OK on the remote to close it.`
        : `${c('green', '✓')} Already installed (the TV has this exact version).`,
    );
  } catch (err) {
    if (err instanceof SideloadError) {
      console.error(c('red', `✗ ${err.message}`));
      if (err.kind === 'unreachable') {
        console.error(
          dim(
            '  Turn on developer mode with the remote: Home ×3, Up ×2, Right, Left, Right, Left, Right. See README §12.',
          ),
        );
      }
      process.exit(1);
    }
    throw err;
  }

  // Tell the service right away (it would notice at its next channel-list refresh anyway).
  const client = new EcpClient({ ...address, timeoutMs: config.monitor.requestTimeoutMs });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const apps = await client.apps();
      if (apps.some((a) => a.id === config.tvMessages.appId)) {
        withRepos(config, (r) => {
          const now = Date.now();
          r.apps.syncInstalled(apps, now);
          r.events.add({
            at: now,
            type: 'service',
            severity: 'info',
            message: `Parental Control channel installed on the TV (v${version})`,
          });
        });
        console.log(dim('   The service will use it for messages from now on (Settings → TV messages).'));
        return;
      }
    } catch {
      // the TV is busy starting the channel; try again
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(dim('   The service will pick the channel up within 15 minutes, or at its next restart.'));
}

export async function messageCommand(config: Config, text: string | undefined, opts: { host?: string; test: boolean }) {
  if (!opts.test && !text?.trim()) throw new Error('Usage: npm run message -- "Dinner’s ready!"   (or --test)');
  const address = tvAddress(config, opts.host);
  const client = new EcpClient({ ...address, timeoutMs: config.monitor.requestTimeoutMs });
  // The words as the service uses them: the dashboard's edits win over config.json.
  const texts = withRepos(config, (r) => new RuntimeConfig(config, r.settings, createCliLogger()).tvMessages.texts);
  const msg = opts.test ? testMessage() : parentMessage(text!, { returnSec: 0, appName: null, texts });
  try {
    const apps = await client.apps();
    if (!apps.some((a) => a.id === config.tvMessages.appId)) {
      throw new Error('The Parental Control channel isn’t on the TV yet. Install it with: npm run channel:install');
    }
    await client.launch(config.tvMessages.appId, toChannelParams(msg));
  } catch (err) {
    if (isEcpError(err, 'restricted'))
      throw new Error('The TV refused (HTTP 403): set Control by mobile apps → Network access to Enabled.', {
        cause: err,
      });
    throw err;
  }
  withRepos(config, (r) =>
    r.events.add({
      at: Date.now(),
      type: 'message',
      severity: 'info',
      message: `Message shown on the TV: “${msg.title}”`,
    }),
  );
  console.log(`${c('green', '✓')} Shown on the TV: ${bold(msg.title)}`);
}

export async function backupCommand(config: Config, list: boolean): Promise<void> {
  const db = openDatabase(config.database.path, { logger: createCliLogger() });
  try {
    const backups = new BackupService({
      db,
      config: { ...config.backup, enabled: true },
      zone: config.timezone,
      clock: systemClock,
      logger: createCliLogger(),
      events: createRepos(db).events,
    });
    if (!list) {
      const res = await backups.backupNow();
      if (!res) throw new Error('Backup failed (see the message above)');
      console.log(`${c('green', '✓')} Backed up to ${res.file} (${kb(res.bytes)})`);
    }
    const all = backups.list();
    if (!all.length) {
      console.log(dim(`No backups in ${config.backup.dir} yet.`));
      return;
    }
    console.log(
      table(
        ['Day', 'Size', 'File'],
        all.map((b) => [b.day, kb(b.bytes), b.file]),
      ),
    );
    console.log(dim(`Keeping the newest ${config.backup.keep}. To restore one, see README §14.`));
  } finally {
    db.close();
  }
}
