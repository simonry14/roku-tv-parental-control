import { describe, expect, it } from 'vitest';
import { parseArpOutput, pingOutputIndicatesReply } from '../../src/ecp/reachability.js';
import { isLanAddress, normaliseMac } from '../../src/lib/net.js';

describe('ping output', () => {
  it('detects a Windows echo reply', () => {
    expect(pingOutputIndicatesReply('Reply from 192.168.1.23: bytes=32 time=3ms TTL=64')).toBe(true);
  });
  it('rejects a Windows "destination host unreachable" (exit code 0!)', () => {
    expect(pingOutputIndicatesReply('Reply from 192.168.1.10: Destination host unreachable.\r\n')).toBe(false);
    expect(pingOutputIndicatesReply('Request timed out.')).toBe(false);
  });
  it('detects a Linux/macOS reply', () => {
    expect(pingOutputIndicatesReply('64 bytes from 192.168.1.23: icmp_seq=1 ttl=64 time=2.1 ms')).toBe(true);
  });
});

describe('ARP output', () => {
  it('parses Windows arp -a', () => {
    const out = `\r\nInterface: 192.168.1.10 --- 0x5\r\n  Internet Address      Physical Address      Type\r\n  192.168.1.23          d8-31-34-aa-bb-cc     dynamic\r\n`;
    expect(parseArpOutput(out, '192.168.1.23')).toBe('d8:31:34:aa:bb:cc');
  });
  it('parses Linux ip neigh', () => {
    expect(parseArpOutput('192.168.1.23 dev eth0 lladdr d8:31:34:aa:bb:cc REACHABLE', '192.168.1.23')).toBe(
      'd8:31:34:aa:bb:cc',
    );
  });
  it('parses macOS arp with unpadded octets', () => {
    expect(parseArpOutput('? (192.168.1.23) at d8:31:34:a:b:c on en0 ifscope [ethernet]', '192.168.1.23')).toBe(
      'd8:31:34:0a:0b:0c',
    );
  });
  it('returns null when there is no entry', () => {
    expect(parseArpOutput('No ARP Entries Found.', '192.168.1.23')).toBeNull();
    expect(parseArpOutput('192.168.1.23 dev eth0 FAILED', '192.168.1.23')).toBeNull();
  });
});

describe('net helpers', () => {
  it('normalises MACs', () => {
    expect(normaliseMac('D8-31-34-AA-BB-CC')).toBe('d8:31:34:aa:bb:cc');
    expect(normaliseMac('00:00:00:00:00:00')).toBeNull();
    expect(normaliseMac('nonsense')).toBeNull();
  });
  it('classifies LAN addresses', () => {
    for (const ip of [
      '192.168.1.5',
      '10.0.0.1',
      '172.16.4.4',
      '172.31.255.1',
      '127.0.0.1',
      '::ffff:192.168.0.2',
      '::1',
    ]) {
      expect(isLanAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '192.169.0.1', 'garbage']) {
      expect(isLanAddress(ip), ip).toBe(false);
    }
  });
});
