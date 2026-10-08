import { execFile } from 'node:child_process';
import { normaliseMac } from '../lib/net.js';

/**
 * Host-identity checks used when port 8060 refuses connections: is the device at the pinned
 * address still our TV (ECP disabled → tamper) or something else (DHCP reassigned it)?
 * The ARP MAC decides; the ping mostly ensures the ARP entry is fresh. Both shell out to OS
 * tools (no raw sockets → no admin rights) and never throw — missing tools just yield nulls.
 */

export interface PresenceResult {
  /** Host answered an ICMP echo. */
  alive: boolean;
  /** MAC found in the ARP/neighbour table for this IP, if any. */
  mac: string | null;
}

export interface Reachability {
  presence(host: string): Promise<PresenceResult>;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });
}

/**
 * Windows `ping` exits 0 even for "Reply from <gateway>: Destination host unreachable", so we
 * look for a real echo reply ("TTL=") instead of trusting the exit code.
 */
export function pingOutputIndicatesReply(stdout: string): boolean {
  return /ttl[=\s]\d+/i.test(stdout);
}

export function parseArpOutput(stdout: string, host: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes(host)) continue;
    // Windows: "  192.168.1.23          a4-c1-38-00-11-22     dynamic"
    // Linux:   "192.168.1.23 dev eth0 lladdr a4:c1:38:00:11:22 REACHABLE"
    // macOS:   "? (192.168.1.23) at a4:c1:38:0:11:22 on en0 ifscope [ethernet]"
    const m = /([0-9a-f]{1,2}(?:[-:][0-9a-f]{1,2}){5})/i.exec(line);
    if (m) {
      const parts = m[1]!.split(/[-:]/).map((p) => p.padStart(2, '0'));
      return normaliseMac(parts.join(''));
    }
  }
  return null;
}

export class SystemReachability implements Reachability {
  constructor(private readonly timeoutMs = 1500) {}

  async presence(host: string): Promise<PresenceResult> {
    const alive = await this.ping(host);
    const mac = await this.arp(host);
    return { alive, mac };
  }

  async ping(host: string): Promise<boolean> {
    const isWin = process.platform === 'win32';
    const args = isWin
      ? ['-n', '1', '-w', String(this.timeoutMs), host]
      : [
          '-c',
          '1',
          process.platform === 'darwin' ? '-t' : '-W',
          String(Math.max(1, Math.ceil(this.timeoutMs / 1000))),
          host,
        ];
    const { stdout } = await run('ping', args, this.timeoutMs + 1500);
    return pingOutputIndicatesReply(stdout);
  }

  async arp(host: string): Promise<string | null> {
    const isWin = process.platform === 'win32';
    const { stdout } =
      isWin || process.platform === 'darwin'
        ? await run('arp', ['-a', host], 3000)
        : await run('ip', ['neigh', 'show', host], 3000);
    return parseArpOutput(stdout, host);
  }
}
