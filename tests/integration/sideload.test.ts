import { afterEach, describe, expect, it } from 'vitest';
import { buildChannelPackage } from '../../src/channel/package.js';
import { sideloadChannel } from '../../src/channel/sideload.js';
import type { MockRoku } from '../../mock/mock-roku.js';
import { mockRoku } from '../helpers.js';

const mocks: MockRoku[] = [];
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((m) => m.close()));
});

describe('sideloading the channel (mock developer installer)', () => {
  it('installs with Digest auth, then reports an identical package', async () => {
    const tv = await mockRoku({
      devInstaller: { port: 0, password: 'tvpass' },
      initial: { devChannelInstalled: false },
    });
    mocks.push(tv);
    const zip = buildChannelPackage();
    const opts = { host: '127.0.0.1', port: tv.devInstallerPort!, password: 'tvpass', zip };

    await expect(sideloadChannel(opts)).resolves.toMatchObject({ status: 'installed' });
    expect(tv.state.devChannelInstalled).toBe(true);
    expect(tv.state.activeAppId).toBe('dev'); // the TV opens it straight away
    expect(tv.state.devChannelVersion).toMatch(/^1\.\d+\.\d+$/);
    expect(tv.sideloads[0]).toMatchObject({ bytes: zip.length });
    expect(tv.sideloads[0]?.entries).toContain('manifest');

    await expect(sideloadChannel(opts)).resolves.toMatchObject({ status: 'identical' });
  });

  it('explains a wrong password and a TV without developer mode', async () => {
    const tv = await mockRoku({ devInstaller: { port: 0, password: 'tvpass' } });
    mocks.push(tv);
    const zip = buildChannelPackage();
    await expect(
      sideloadChannel({ host: '127.0.0.1', port: tv.devInstallerPort!, password: 'nope', zip }),
    ).rejects.toMatchObject({ kind: 'auth' });

    const port = tv.devInstallerPort!;
    await tv.close();
    mocks.length = 0;
    await expect(sideloadChannel({ host: '127.0.0.1', port, password: 'tvpass', zip })).rejects.toMatchObject({
      kind: 'unreachable',
      message: expect.stringMatching(/Developer mode looks switched off/),
    });
  });
});
