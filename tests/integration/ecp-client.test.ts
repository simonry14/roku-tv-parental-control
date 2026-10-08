import { afterEach, describe, expect, it } from 'vitest';
import { EcpClient } from '../../src/ecp/client.js';
import { EcpError } from '../../src/ecp/types.js';
import type { MockRoku } from '../../mock/mock-roku.js';
import { mockRoku } from '../helpers.js';

let mock: MockRoku | null = null;
afterEach(async () => {
  await mock?.close();
  mock = null;
});

const clientFor = (m: MockRoku, timeoutMs = 1000): EcpClient =>
  new EcpClient({ host: '127.0.0.1', port: m.ecpPort, timeoutMs });

async function errorKind(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return err instanceof EcpError ? err.kind : `non-ecp: ${(err as Error).message}`;
  }
}

describe('EcpClient ↔ mock Roku', () => {
  it('queries device-info, active-app, apps, media-player and icons', async () => {
    mock = await mockRoku();
    const c = clientFor(mock);

    const info = await c.deviceInfo();
    expect(info.serialNumber).toBe('YJ00MOCK0001');
    expect(info.powerMode).toBe('PowerOn');
    expect(info.macs).toEqual(['d8:31:34:00:be:ef']);

    expect((await c.activeApp()).app).toBeNull();
    const apps = await c.apps();
    expect(apps.find((a) => a.id === '12')?.name).toBe('Netflix');
    expect(apps.find((a) => a.id === 'tvinput.hdmi1')?.type).toBe('tvin');

    const icon = await c.icon('12');
    expect(icon.contentType).toContain('image/');
    expect(icon.data.length).toBeGreaterThan(50);

    expect((await c.mediaPlayer()).state).toBe('close');
  });

  it('launch and keypress drive the TV state', async () => {
    mock = await mockRoku();
    const c = clientFor(mock);
    await c.launch('837');
    expect((await c.activeApp()).app?.name).toBe('YouTube');
    expect((await c.mediaPlayer()).pluginId).toBe('837');

    await c.keypress('Home');
    expect((await c.activeApp()).app).toBeNull();

    await c.keypress('PowerOff');
    expect((await c.deviceInfo()).powerMode).toBe('DisplayOff');
    expect(mock.history.map((h) => h.path)).toEqual(['/launch/837', '/keypress/Home', '/keypress/PowerOff']);

    expect(await errorKind(c.launch('nope'))).toBe('http');
  });

  it('screensaver shows up alongside the app', async () => {
    mock = await mockRoku({ initial: { activeAppId: '12', screensaver: true } });
    const a = await clientFor(mock).activeApp();
    expect(a.app?.id).toBe('12');
    expect(a.screensaver?.type).toBe('ssvr');
  });

  it('Limited mode: queries work, control and icons are restricted (403)', async () => {
    mock = await mockRoku({ initial: { access: 'limited' } });
    const c = clientFor(mock);
    expect((await c.deviceInfo()).serialNumber).toBe('YJ00MOCK0001');
    expect(await errorKind(c.activeApp())).toBe('ok');
    expect(await errorKind(c.keypress('Home'))).toBe('restricted');
    expect(await errorKind(c.icon('12'))).toBe('restricted');
  });

  it('Disabled mode: refuse variant closes the port; default (real-TV) variant answers 403', async () => {
    mock = await mockRoku({ disabledBehavior: 'refuse' });
    const c = clientFor(mock);
    await mock.set({ access: 'disabled' });
    expect(await errorKind(c.deviceInfo())).toBe('refused');
    await mock.set({ access: 'enabled' });
    expect(await errorKind(c.deviceInfo())).toBe('ok'); // listener comes back on the same port
    await mock.close();

    mock = await mockRoku({ initial: { access: 'disabled' } });
    expect(await errorKind(clientFor(mock).deviceInfo())).toBe('restricted');
  });

  it('offline TV times out', async () => {
    mock = await mockRoku({ initial: { offline: true } });
    const started = Date.now();
    expect(await errorKind(clientFor(mock, 300).deviceInfo())).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('nothing listening = refused; an unroutable address fails fast with an EcpError', async () => {
    expect(await errorKind(new EcpClient({ host: '127.0.0.1', port: 1, timeoutMs: 500 }).deviceInfo())).toBe('refused');
    // TEST-NET-1: times out on a normal LAN; some sandboxes/firewalls reject it instead.
    const kind = await errorKind(new EcpClient({ host: '192.0.2.1', port: 8060, timeoutMs: 300 }).deviceInfo());
    expect(['timeout', 'unreachable', 'refused']).toContain(kind);
  });
});
