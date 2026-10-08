import type { Logger } from 'pino';
import type { DevicesRepo, EventsRepo } from '../db/repo.js';
import type { Clock } from '../lib/time.js';
import type { DiscoveredDevice } from './discovery.js';
import { isEcpError, type DeviceInfo } from './types.js';

export interface DeviceTarget {
  serial: string;
  host: string;
  port: number;
  name: string;
  model: string | null;
  macs: string[];
}

export type LocateVia = 'manual' | 'last-known' | 'ssdp' | 'scan';

export type LocateResult =
  | {
      ok: true;
      target: DeviceTarget;
      /** Null when the TV was identified (by its SSDP serial) but refused ECP queries. */
      info: DeviceInfo | null;
      /** The TV refused ECP (HTTP 401/403, or port 8060 closed): the poller will report `restricted`. */
      restricted: boolean;
      via: LocateVia;
      pinnedNow: boolean;
    }
  | { ok: false; reason: string; candidates: DiscoveredDevice[] };

export interface LocatorConfig {
  /** Serial from config.json — overrides whatever is pinned in the DB. */
  serial?: string | undefined;
  /** Manual IP from config.json — tried first. */
  host?: string | undefined;
  port: number;
  subnetScan: boolean;
  scanMinIntervalMs: number;
}

export interface LocatorDeps {
  devices: DevicesRepo;
  events?: EventsRepo;
  probe(host: string, port: number): Promise<DeviceInfo>;
  ssdp(opts: { stopOnSerial?: string }): Promise<DiscoveredDevice[]>;
  scan(opts: { stopOnSerial?: string }): Promise<DiscoveredDevice[]>;
  clock: Clock;
  logger: Logger;
}

/**
 * Finds the TV and keeps it pinned by serial number, so a DHCP address change is followed
 * automatically. Search order: manual host → last-known address → SSDP → subnet scan.
 */
export class DeviceLocator {
  private lastScanAt = Number.NEGATIVE_INFINITY;

  constructor(
    private cfg: LocatorConfig,
    private readonly deps: LocatorDeps,
  ) {}

  /** Apply changed device settings (dashboard). Takes effect on the next locate(). */
  setDevice(d: { serial?: string | undefined; host?: string | undefined }): void {
    this.cfg = { ...this.cfg, serial: d.serial, host: d.host };
  }

  /** Serial we are looking for: config.json wins, else the pinned device, else none yet. */
  expectedSerial(): string | null {
    return this.cfg.serial ?? this.deps.devices.pinned()?.serial ?? null;
  }

  /**
   * Best unverified guess at where the TV is (used while it's unreachable so we keep polling
   * the last address instead of waiting for the next discovery round).
   */
  fallbackTarget(): DeviceTarget | null {
    const serial = this.expectedSerial();
    const known = serial ? this.deps.devices.get(serial) : null;
    const host = this.cfg.host ?? known?.host;
    if (!serial || !host) return null;
    return {
      serial,
      host,
      port: this.cfg.host ? this.cfg.port : (known?.port ?? this.cfg.port),
      name: known?.name ?? 'Roku TV',
      model: known?.model ?? null,
      macs: known?.macs ?? [],
    };
  }

  async locate(opts: { allowScan?: boolean } = {}): Promise<LocateResult> {
    const { devices, logger } = this.deps;
    const expected = this.expectedSerial();
    const tried = new Set<string>();

    /** Rokus that answered but refused ECP — used for a precise failure reason. */
    const refusedBy: string[] = [];

    /**
     * Probe host:port. `advertisedSerial` is the serial the device announced in its SSDP USN (or
     * that a scan saw); when device-info is refused we can still identify the TV by it.
     */
    const tryHost = async (
      host: string,
      port: number,
      via: LocateVia,
      advertisedSerial: string | null = null,
    ): Promise<LocateResult | null> => {
      const key = `${host}:${port}`;
      if (tried.has(key)) return null;
      tried.add(key);
      let info: DeviceInfo;
      try {
        info = await this.deps.probe(host, port);
      } catch (err) {
        logger.debug({ host, port, via, err: (err as Error).message }, 'Locator: probe failed');
        // HTTP 401/403 proves an ECP server (a Roku) is there; a refusal right after SSDP announced
        // this serial at this address means ECP is switched off on that TV. Either way, pin it so
        // the poller reports "restricted" with the fix, rather than "no Roku found".
        const ecpAnswered = isEcpError(err, 'restricted');
        const announced = advertisedSerial !== null && isEcpError(err, 'refused');
        if (ecpAnswered || announced) {
          const serial = advertisedSerial ?? expected;
          refusedBy.push(`${serial ?? 'unknown serial'} at ${key} (${(err as Error).message})`);
          if (serial && (!expected || serial === expected)) {
            logger.warn({ host, port, serial, via }, 'Locator: TV found but it refuses ECP — pinning anyway');
            return this.accept(serial, host, port, null, via);
          }
        }
        return null;
      }
      if (expected && info.serialNumber && info.serialNumber !== expected) {
        logger.warn(
          { host, port, found: info.serialNumber, expected },
          'Locator: a different Roku answered at this address',
        );
        return null;
      }
      const serial = info.serialNumber ?? advertisedSerial ?? expected;
      if (!serial) {
        logger.warn({ host, port }, 'Locator: device-info has no serial-number; cannot pin this device');
        return null;
      }
      return this.accept(serial, host, port, info, via);
    };

    // 1–2. Known addresses
    if (this.cfg.host) {
      const r = await tryHost(this.cfg.host, this.cfg.port, 'manual');
      if (r) return r;
    }
    const known = expected ? devices.get(expected) : null;
    if (known?.host) {
      const r = await tryHost(known.host, known.port, 'last-known');
      if (r) return r;
    }

    // 3. SSDP
    const ssdpFound = await this.deps.ssdp(expected ? { stopOnSerial: expected } : {});
    const fromSsdp = await this.pick(ssdpFound, expected, tryHost);
    if (fromSsdp) return fromSsdp;
    if (!expected && ssdpFound.length > 1) return this.ambiguous(ssdpFound);

    // 4. Subnet scan (throttled — it probes every host on the /24)
    const now = this.deps.clock.now();
    let scanFound: DiscoveredDevice[] = [];
    if (opts.allowScan !== false && this.cfg.subnetScan && now - this.lastScanAt >= this.cfg.scanMinIntervalMs) {
      this.lastScanAt = now;
      scanFound = await this.deps.scan(expected ? { stopOnSerial: expected } : {});
      const fromScan = await this.pick(scanFound, expected, tryHost);
      if (fromScan) return fromScan;
      if (!expected && scanFound.length > 1) return this.ambiguous(scanFound);
    }

    const candidates = dedupe([...ssdpFound, ...scanFound]);
    if (refusedBy.length) {
      return {
        ok: false,
        reason: `Found Roku ${refusedBy.join('; ')} but it refuses ECP. On the TV: Settings → System → Advanced system settings → Control by mobile apps → Network access → Enabled.`,
        candidates,
      };
    }
    return {
      ok: false,
      reason: expected
        ? `TV ${expected} not found (tried ${[...tried].join(', ') || 'no known address'}; SSDP found ${ssdpFound.length} Roku(s))`
        : 'No Roku found on the network. Check it is on the same LAN, or set device.host in config.json.',
      candidates,
    };
  }

  private async pick(
    found: DiscoveredDevice[],
    expected: string | null,
    tryHost: (
      host: string,
      port: number,
      via: LocateVia,
      advertisedSerial?: string | null,
    ) => Promise<LocateResult | null>,
  ): Promise<LocateResult | null> {
    if (expected) {
      // Prefer exact serial matches; devices without a serial in their USN are probed too.
      const ordered = [...found.filter((d) => d.serial === expected), ...found.filter((d) => d.serial === null)];
      for (const d of ordered) {
        const r = await tryHost(d.host, d.port, d.via, d.serial);
        if (r) return r;
      }
      return null;
    }
    const only = found.length === 1 ? found[0]! : null;
    return only ? tryHost(only.host, only.port, only.via, only.serial) : null;
  }

  private ambiguous(found: DiscoveredDevice[]): LocateResult {
    return {
      ok: false,
      reason: `Found ${found.length} Rokus — set device.serial in config.json to choose one (see: npm run discover)`,
      candidates: dedupe(found),
    };
  }

  private accept(serial: string, host: string, port: number, info: DeviceInfo | null, via: LocateVia): LocateResult {
    const { devices, events, clock, logger } = this.deps;
    const now = clock.now();
    const previous = devices.get(serial);
    const record = devices.upsert(
      { serial, name: info?.name ?? null, model: info?.modelName ?? null, host, port, macs: info?.macs ?? [] },
      now,
    );
    const name = record.name ?? 'Roku TV';
    const pinned = devices.pinned();
    let pinnedNow = false;
    if (!pinned || (this.cfg.serial && pinned.serial !== this.cfg.serial && serial === this.cfg.serial)) {
      devices.pin(serial);
      pinnedNow = true;
      events?.add({
        at: now,
        type: 'device',
        severity: 'info',
        message: `Pinned TV "${name}" (serial ${serial})`,
        data: { serial, host, port, via, restricted: info === null },
      });
      logger.info({ serial, tvName: name, host, port, via }, 'Pinned TV');
    }
    if (previous?.host && (previous.host !== host || previous.port !== port)) {
      events?.add({
        at: now,
        type: 'device',
        severity: 'info',
        message: `TV address changed ${previous.host}:${previous.port} → ${host}:${port}`,
        data: { serial, from: `${previous.host}:${previous.port}`, to: `${host}:${port}`, via },
      });
      logger.info({ serial, from: previous.host, to: host, via }, 'TV address changed');
    }
    return {
      ok: true,
      via,
      pinnedNow,
      info,
      restricted: info === null,
      target: { serial, host, port, name, model: record.model, macs: record.macs },
    };
  }
}

function dedupe(list: DiscoveredDevice[]): DiscoveredDevice[] {
  const map = new Map<string, DiscoveredDevice>();
  for (const d of list)
    map.set(d.serial ?? `${d.host}:${d.port}`, { ...map.get(d.serial ?? `${d.host}:${d.port}`), ...d });
  return [...map.values()];
}
