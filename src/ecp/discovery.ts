import dgram from 'node:dgram';
import os from 'node:os';
import type { Logger } from 'pino';
import { EcpClient } from './client.js';

export const SSDP_ADDRESS = '239.255.255.250';
export const SSDP_PORT = 1900;
export const ROKU_ST = 'roku:ecp';

export interface DiscoveredDevice {
  /** Serial from the SSDP USN (uuid:roku:ecp:<serial>) or device-info. */
  serial: string | null;
  host: string;
  port: number;
  via: 'ssdp' | 'scan';
  location?: string;
  server?: string;
  /** Local interface address the reply arrived on. */
  localAddress?: string;
  /** Filled in by subnet scan (it already fetched device-info). */
  name?: string;
  model?: string | null;
  powerMode?: string | null;
}

export interface LocalInterface {
  name: string;
  address: string;
  netmask: string;
  prefixLength: number;
}

// ─── SSDP message helpers (pure) ────────────────────────────────────────────

export function buildMSearch(mx = 2, st = ROKU_ST): Buffer {
  return Buffer.from(
    [
      'M-SEARCH * HTTP/1.1',
      `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
      'MAN: "ssdp:discover"',
      `MX: ${mx}`,
      `ST: ${st}`,
      '',
      '',
    ].join('\r\n'),
  );
}

export interface SsdpMessage {
  startLine: string;
  headers: Record<string, string>;
}

/** Parse an SSDP datagram. Header names are case-insensitive (UPnP DA) — we lower-case them. */
export function parseSsdpMessage(msg: string): SsdpMessage | null {
  const lines = msg.split(/\r?\n/);
  const startLine = lines.shift()?.trim();
  if (!startLine) return null;
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { startLine, headers };
}

/** Turn an M-SEARCH response or NOTIFY into a Roku device, or null if it isn't one. */
export function parseRokuSsdp(msg: string): Omit<DiscoveredDevice, 'via'> | null {
  const parsed = parseSsdpMessage(msg);
  if (!parsed) return null;
  const { startLine, headers } = parsed;
  const isResponse = /^HTTP\/1\.[01]\s+200/i.test(startLine);
  const isNotify = /^NOTIFY\s/i.test(startLine);
  if (!isResponse && !isNotify) return null;

  const st = headers.st ?? headers.nt ?? '';
  const usn = headers.usn ?? '';
  if (st.toLowerCase() !== ROKU_ST && !/roku:ecp/i.test(usn)) return null;

  const location = headers.location;
  if (!location) return null;
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return null;
  }
  const serialMatch = /uuid:roku:ecp:([A-Za-z0-9]+)/i.exec(usn);
  return {
    serial: serialMatch?.[1] ?? null,
    host: url.hostname,
    port: url.port ? Number(url.port) : 8060,
    location,
    ...(headers.server ? { server: headers.server } : {}),
  };
}

// ─── Interfaces ─────────────────────────────────────────────────────────────

/**
 * Non-internal IPv4 interfaces. Windows PCs commonly have Hyper-V/WSL/VPN adapters; we search on
 * all of them because the OS default multicast route often picks the wrong one.
 */
export function listIPv4Interfaces(only?: string[]): LocalInterface[] {
  const out: LocalInterface[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue; // link-local / APIPA
      if (only && only.length && !only.includes(a.address)) continue;
      out.push({ name, address: a.address, netmask: a.netmask, prefixLength: prefixFromNetmask(a.netmask) });
    }
  }
  return out;
}

const VIRTUAL_ADAPTER = /vEthernet|VirtualBox|VMware|Hyper-V|WSL|Loopback|docker|br-|virbr|tailscale|zerotier/i;

/** URLs a phone on the LAN can use to reach a service on this PC (physical adapters first). */
export function lanUrls(port: number): string[] {
  const ifaces = listIPv4Interfaces();
  const sorted = [
    ...ifaces.filter((i) => !VIRTUAL_ADAPTER.test(i.name)),
    ...ifaces.filter((i) => VIRTUAL_ADAPTER.test(i.name)),
  ];
  return sorted.map((i) => `http://${i.address}:${port}/`);
}

export function prefixFromNetmask(mask: string): number {
  return mask
    .split('.')
    .map(Number)
    .reduce((bits, octet) => bits + (octet >>> 0).toString(2).replace(/0/g, '').length, 0);
}

// ─── SSDP search ────────────────────────────────────────────────────────────

export interface SsdpDiscoverOptions {
  timeoutMs?: number;
  /** Local IPv4 addresses to search from; default = all usable interfaces. */
  interfaces?: string[];
  /** Override the destination (tests / unicast search). Default 239.255.255.250:1900. */
  target?: { address: string; port: number };
  /** M-SEARCH is UDP: send it more than once. */
  sends?: number;
  /** Resolve as soon as a device with this serial replies. */
  stopOnSerial?: string;
  logger?: Logger;
}

export async function ssdpDiscover(opts: SsdpDiscoverOptions = {}): Promise<DiscoveredDevice[]> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const target = opts.target ?? { address: SSDP_ADDRESS, port: SSDP_PORT };
  const sends = Math.max(1, opts.sends ?? 3);
  const mx = Math.max(1, Math.min(5, Math.floor(timeoutMs / 1000) - 1 || 1));
  const message = buildMSearch(mx);
  const isMulticast = target.address === SSDP_ADDRESS;

  // Bind one socket per interface for multicast; a single unbound socket for a unicast target.
  const bindAddresses = isMulticast ? listIPv4Interfaces(opts.interfaces).map((i) => i.address) : [undefined];
  if (isMulticast && bindAddresses.length === 0) {
    opts.logger?.warn('SSDP: no usable IPv4 interfaces');
    return [];
  }

  const found = new Map<string, DiscoveredDevice>();
  const sockets: dgram.Socket[] = [];
  const timers: NodeJS.Timeout[] = [];

  return new Promise<DiscoveredDevice[]>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      for (const s of sockets) {
        try {
          s.close();
        } catch {
          /* already closed */
        }
      }
      resolve([...found.values()]);
    };

    for (const localAddress of bindAddresses) {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sockets.push(socket);
      socket.on('error', (err) => {
        opts.logger?.debug({ err, localAddress }, 'SSDP socket error');
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      });
      socket.on('message', (buf, rinfo) => {
        const dev = parseRokuSsdp(buf.toString('utf8'));
        if (!dev) return;
        const key = dev.serial ?? `${dev.host}:${dev.port}`;
        if (!found.has(key)) {
          found.set(key, { ...dev, via: 'ssdp', ...(localAddress ? { localAddress } : {}) });
          opts.logger?.debug({ dev, from: rinfo.address }, 'SSDP: Roku replied');
        }
        if (opts.stopOnSerial && dev.serial === opts.stopOnSerial) finish();
      });
      socket.bind({ address: localAddress, port: 0 }, () => {
        try {
          if (isMulticast && localAddress) {
            socket.setMulticastInterface(localAddress);
            socket.setMulticastTTL(2);
          }
        } catch (err) {
          opts.logger?.debug({ err, localAddress }, 'SSDP: could not set multicast interface');
        }
        for (let i = 0; i < sends; i++) {
          timers.push(
            setTimeout(() => {
              if (done) return;
              socket.send(message, target.port, target.address, (err) => {
                if (err) opts.logger?.debug({ err, localAddress }, 'SSDP: send failed');
              });
            }, i * 400),
          );
        }
      });
    }

    timers.push(setTimeout(finish, timeoutMs));
  });
}

// ─── Subnet scan fallback ───────────────────────────────────────────────────

export interface ScanOptions {
  interfaces?: string[];
  port?: number;
  timeoutMs?: number;
  concurrency?: number;
  /** Resolve early when this serial is found. */
  stopOnSerial?: string;
  logger?: Logger;
  /** Explicit host list (tests). Overrides interface-derived ranges. */
  hosts?: string[];
}

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => ((acc << 8) + Number(o)) >>> 0, 0);
}
function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** Hosts in the interface's subnet, capped to its /24 when the subnet is larger than /23. */
export function subnetHosts(iface: Pick<LocalInterface, 'address' | 'prefixLength'>): string[] {
  const prefix = iface.prefixLength < 23 ? 24 : Math.min(iface.prefixLength, 30);
  const size = 2 ** (32 - prefix);
  const network = (ipToInt(iface.address) & (~(size - 1) >>> 0)) >>> 0;
  const self = ipToInt(iface.address);
  const hosts: string[] = [];
  for (let i = 1; i < size - 1; i++) {
    const n = (network + i) >>> 0;
    if (n !== self) hosts.push(intToIp(n));
  }
  return hosts;
}

/**
 * Probe port 8060 across the local subnet(s) with GET /query/device-info. Used when SSDP is
 * blocked (multicast filtering, Windows firewall, AP isolation) to find a TV whose DHCP lease moved.
 */
export async function scanSubnet(opts: ScanOptions = {}): Promise<DiscoveredDevice[]> {
  const port = opts.port ?? 8060;
  const hosts = opts.hosts ?? [...new Set(listIPv4Interfaces(opts.interfaces).flatMap(subnetHosts))];
  const found: DiscoveredDevice[] = [];
  let next = 0;
  let stop = false;

  const worker = async (): Promise<void> => {
    while (!stop && next < hosts.length) {
      const host = hosts[next++]!;
      try {
        const info = await new EcpClient({ host, port, timeoutMs: opts.timeoutMs ?? 800 }).deviceInfo();
        found.push({
          serial: info.serialNumber,
          host,
          port,
          via: 'scan',
          name: info.name,
          model: info.modelName,
          powerMode: info.powerMode,
        });
        opts.logger?.debug({ host, serial: info.serialNumber }, 'Scan: found Roku');
        if (opts.stopOnSerial && info.serialNumber === opts.stopOnSerial) stop = true;
      } catch {
        // not a Roku / not listening — expected for almost every host
      }
    }
  };

  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 48, hosts.length));
  opts.logger?.debug({ hosts: hosts.length, concurrency }, 'Scan: probing subnet');
  await Promise.all(Array.from({ length: concurrency }, worker));
  return found;
}
