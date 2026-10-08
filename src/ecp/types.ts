/**
 * Roku External Control Protocol (ECP) types.
 * Reference: https://developer.roku.com/docs/developer-program/dev-tools/external-control-api.md
 */

/**
 * `power-mode` from /query/device-info. Only `PowerOn` means the screen is on; everything else
 * (DisplayOff = standby with Fast TV start, Ready, Headless, Suspend, …) is treated as "TV off".
 * Kept open-ended because values vary by firmware.
 */
export type PowerMode = 'PowerOn' | 'DisplayOff' | 'Ready' | 'Headless' | 'Suspend' | (string & {});

export interface DeviceInfo {
  /** Null if the TV redacts it (possible in restricted ECP modes). */
  serialNumber: string | null;
  deviceId: string | null;
  /** Best display name: user-device-name → friendly-device-name → default-device-name → model. */
  name: string;
  modelName: string | null;
  modelNumber: string | null;
  vendorName: string | null;
  softwareVersion: string | null;
  powerMode: PowerMode | null;
  isTv: boolean;
  developerEnabled: boolean;
  /** Lower-case colon-separated MACs (wifi and/or ethernet) — used to confirm presence via ARP. */
  macs: string[];
  /** Every scalar field as returned, for diagnostics. */
  raw: Record<string, string>;
}

/** `type` attribute on <app>: appl = channel, tvin = TV input (HDMI/tuner), ssvr = screensaver. */
export type AppType = 'appl' | 'tvin' | 'ssvr' | 'menu' | 'home' | (string & {});

export interface RokuApp {
  id: string;
  name: string;
  type: AppType | null;
  version: string | null;
}

export interface ActiveApp {
  /** The foreground app, or null when on the Home screen. */
  app: RokuApp | null;
  /** Present when a screensaver is running (on top of `app` or Home). */
  screensaver: RokuApp | null;
}

export interface MediaPlayerState {
  /** e.g. play, pause, buffer, stop, close, open, none. Best-effort — varies by channel. */
  state: string | null;
  error: boolean;
  pluginId: string | null;
  pluginName: string | null;
  positionMs: number | null;
  durationMs: number | null;
  isLive: boolean | null;
}

export interface EcpIcon {
  contentType: string;
  data: Buffer;
}

/** Documented keys we use, plus PowerOn/Power which Roku TVs accept but the docs don't list. */
export type EcpKey =
  | 'Home'
  | 'Back'
  | 'Select'
  | 'Up'
  | 'Down'
  | 'Left'
  | 'Right'
  | 'Play'
  | 'Info'
  | 'PowerOff'
  | 'PowerOn'
  | 'Power'
  | 'VolumeMute'
  | (string & {});

/** How a request failed. `restricted` = the TV answered but refused (401/403). */
export type EcpErrorKind = 'timeout' | 'unreachable' | 'refused' | 'restricted' | 'http' | 'parse';

export class EcpError extends Error {
  override readonly name = 'EcpError';
  constructor(
    readonly kind: EcpErrorKind,
    message: string,
    readonly details: { endpoint: string; status?: number; code?: string } = { endpoint: '' },
  ) {
    super(message);
  }
}

export function isEcpError(err: unknown, kind?: EcpErrorKind): err is EcpError {
  return err instanceof EcpError && (kind === undefined || err.kind === kind);
}
