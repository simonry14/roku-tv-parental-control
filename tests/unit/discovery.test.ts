import { describe, expect, it } from 'vitest';
import {
  buildMSearch,
  parseRokuSsdp,
  parseSsdpMessage,
  prefixFromNetmask,
  subnetHosts,
} from '../../src/ecp/discovery.js';

describe('SSDP parsing', () => {
  it('builds a Roku M-SEARCH', () => {
    const msg = buildMSearch(2).toString();
    expect(msg).toMatch(/^M-SEARCH \* HTTP\/1\.1\r\n/);
    expect(msg).toContain('ST: roku:ecp\r\n');
    expect(msg).toContain('MAN: "ssdp:discover"\r\n');
    expect(msg.endsWith('\r\n\r\n')).toBe(true);
  });

  it('parses the documented Roku response', () => {
    const dev = parseRokuSsdp(
      'HTTP/1.1 200 OK\r\nCache-Control: max-age=3600\r\nST: roku:ecp\r\nLocation: http://192.168.1.134:8060/\r\nUSN: uuid:roku:ecp:P0A070000007\r\n\r\n',
    );
    expect(dev).toEqual({
      serial: 'P0A070000007',
      host: '192.168.1.134',
      port: 8060,
      location: 'http://192.168.1.134:8060/',
    });
  });

  it('treats header names case-insensitively', () => {
    const dev = parseRokuSsdp(
      'HTTP/1.1 200 OK\r\nst: ROKU:ECP\r\nLOCATION: http://10.0.0.5:8060/\r\nusn: uuid:roku:ecp:ABC123\r\nSERVER: Roku/14.1\r\n\r\n',
    );
    expect(dev?.serial).toBe('ABC123');
    expect(dev?.server).toBe('Roku/14.1');
  });

  it('accepts NOTIFY announcements', () => {
    const dev = parseRokuSsdp(
      'NOTIFY * HTTP/1.1\r\nNT: roku:ecp\r\nNTS: ssdp:alive\r\nLocation: http://10.0.0.9:8060/\r\nUSN: uuid:roku:ecp:ZZZ\r\n\r\n',
    );
    expect(dev?.host).toBe('10.0.0.9');
  });

  it('ignores non-Roku devices, M-SEARCH echoes and junk', () => {
    expect(
      parseRokuSsdp(
        'HTTP/1.1 200 OK\r\nST: urn:dial-multiscreen-org:service:dial:1\r\nLocation: http://10.0.0.2:8008/\r\n\r\n',
      ),
    ).toBeNull();
    expect(parseRokuSsdp(buildMSearch().toString())).toBeNull();
    expect(parseRokuSsdp('HTTP/1.1 200 OK\r\nST: roku:ecp\r\nLocation: not a url\r\n\r\n')).toBeNull();
    expect(parseRokuSsdp('')).toBeNull();
    expect(parseSsdpMessage('')).toBeNull();
  });
});

describe('subnet helpers', () => {
  it('computes prefix lengths', () => {
    expect(prefixFromNetmask('255.255.255.0')).toBe(24);
    expect(prefixFromNetmask('255.255.254.0')).toBe(23);
    expect(prefixFromNetmask('255.255.0.0')).toBe(16);
  });

  it('enumerates a /24 without network, broadcast or self', () => {
    const hosts = subnetHosts({ address: '192.168.1.10', prefixLength: 24 });
    expect(hosts).toHaveLength(253);
    expect(hosts[0]).toBe('192.168.1.1');
    expect(hosts.at(-1)).toBe('192.168.1.254');
    expect(hosts).not.toContain('192.168.1.10');
  });

  it('caps large subnets to the local /24', () => {
    const hosts = subnetHosts({ address: '10.20.30.40', prefixLength: 16 });
    expect(hosts).toHaveLength(253);
    expect(hosts.every((h) => h.startsWith('10.20.30.'))).toBe(true);
  });

  it('handles a /23', () => {
    expect(subnetHosts({ address: '192.168.3.7', prefixLength: 23 })).toHaveLength(509);
  });
});
