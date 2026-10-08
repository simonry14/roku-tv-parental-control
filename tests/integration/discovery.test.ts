import { afterEach, describe, expect, it } from 'vitest';
import { scanSubnet, ssdpDiscover } from '../../src/ecp/discovery.js';
import type { MockRoku } from '../../mock/mock-roku.js';
import { mockRoku } from '../helpers.js';

let mocks: MockRoku[] = [];
afterEach(async () => {
  await Promise.all(mocks.map((m) => m.close()));
  mocks = [];
});

describe('discovery against the mock', () => {
  it('SSDP (unicast M-SEARCH) finds the TV and its serial', async () => {
    const m = await mockRoku({ ssdp: { port: 0, advertiseHost: '127.0.0.1' } });
    mocks.push(m);
    const found = await ssdpDiscover({ target: { address: '127.0.0.1', port: m.ssdpPort! }, timeoutMs: 800 });
    expect(found).toEqual([
      expect.objectContaining({ serial: 'YJ00MOCK0001', host: '127.0.0.1', port: m.ecpPort, via: 'ssdp' }),
    ]);
  });

  it('SSDP stops early when the wanted serial replies', async () => {
    const m = await mockRoku({ ssdp: { port: 0, advertiseHost: '127.0.0.1' } });
    mocks.push(m);
    const t0 = Date.now();
    await ssdpDiscover({
      target: { address: '127.0.0.1', port: m.ssdpPort! },
      timeoutMs: 3000,
      stopOnSerial: 'YJ00MOCK0001',
    });
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('an offline TV does not answer SSDP', async () => {
    const m = await mockRoku({ ssdp: { port: 0, advertiseHost: '127.0.0.1' }, initial: { offline: true } });
    mocks.push(m);
    expect(await ssdpDiscover({ target: { address: '127.0.0.1', port: m.ssdpPort! }, timeoutMs: 600 })).toEqual([]);
  });

  it('subnet scan probes device-info and reports serials', async () => {
    const a = await mockRoku({ initial: { serial: 'AAA111' } });
    mocks.push(a);
    // Scan a "subnet" consisting of loopback aliases; only 127.0.0.1 has the mock.
    const found = await scanSubnet({ hosts: ['127.0.0.1', '127.0.0.2', '127.0.0.3'], port: a.ecpPort, timeoutMs: 300 });
    expect(found).toEqual([
      expect.objectContaining({ serial: 'AAA111', host: '127.0.0.1', via: 'scan', powerMode: 'PowerOn' }),
    ]);
  });
});
