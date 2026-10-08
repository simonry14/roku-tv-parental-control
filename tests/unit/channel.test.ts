import { describe, expect, it } from 'vitest';
import { buildChannelPackage, channelEntries, channelVersion } from '../../src/channel/package.js';
import { digestAuthorization, parseDigestChallenge, parseInstallerResponse } from '../../src/channel/sideload.js';
import { createZip, listZipEntries, readZipEntry } from '../../src/channel/zip.js';

describe('zip writer', () => {
  it('round-trips stored and deflated entries, deterministically', () => {
    const entries = [
      { name: 'manifest', data: Buffer.from('title=Test\n'.repeat(20)) },
      { name: 'images/x.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
      { name: 'source/main.brs', data: Buffer.from('sub Main()\nend sub\n') },
    ];
    const a = createZip(entries);
    expect(createZip(entries).equals(a)).toBe(true);
    expect(listZipEntries(a)).toEqual(['manifest', 'images/x.png', 'source/main.brs']);
    for (const e of entries) expect(readZipEntry(a, e.name)?.equals(e.data)).toBe(true);
    expect(() => createZip([{ name: 'C:\\evil', data: Buffer.alloc(0) }])).toThrow();
  });

  it('packages the real channel with the manifest at the root', () => {
    const names = channelEntries().map((e) => e.name);
    expect(names).toContain('manifest');
    expect(names).toContain('source/main.brs');
    expect(names).toContain('components/MessageScene.xml');
    expect(names.some((n) => n.startsWith('art/'))).toBe(false);
    const zip = buildChannelPackage();
    expect(listZipEntries(zip)).toEqual(names);
    expect(zip.length).toBeLessThan(2 * 1024 * 1024);
    expect(channelVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('HTTP Digest', () => {
  it('matches the RFC 2617 worked example', () => {
    const ch = parseDigestChallenge(
      'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
    )!;
    expect(ch).toMatchObject({ realm: 'testrealm@host.com', qop: 'auth,auth-int' });
    const header = digestAuthorization(ch, {
      method: 'GET',
      uri: '/dir/index.html',
      username: 'Mufasa',
      password: 'Circle Of Life',
      cnonce: '0a4f113b',
      nc: 1,
    });
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(header).toContain('qop=auth, nc=00000001, cnonce="0a4f113b"');
    expect(header).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  });

  it('rejects non-digest challenges', () => {
    expect(parseDigestChallenge('Basic realm="x"')).toBeNull();
    expect(parseDigestChallenge(undefined)).toBeNull();
  });

  it('reads the installer verdict from old and new firmware pages', () => {
    expect(parseInstallerResponse(`<font color="red">Install Success.</font>`).status).toBe('installed');
    expect(
      parseInstallerResponse(
        `Shell.create('Roku.Message').trigger('Set message content', 'Identical to previous version -- not replacing.')`,
      ).status,
    ).toBe('identical');
    expect(parseInstallerResponse(`<font color="red">Install Failure: Compilation Failed.</font>`)).toEqual({
      status: 'failed',
      message: 'Install Failure: Compilation Failed.',
    });
  });
});
