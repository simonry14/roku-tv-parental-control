import { XMLParser } from 'fast-xml-parser';
import { normaliseMac } from '../lib/net.js';
import type { ActiveApp, DeviceInfo, MediaPlayerState, RokuApp } from './types.js';

/**
 * Pure parsers for ECP XML payloads. Kept separate from the HTTP client so they can be unit
 * tested against captured responses (see tests/fixtures).
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name, jpath) => jpath === 'apps.app',
});

type XmlNode = string | { '#text'?: string; [attr: string]: unknown } | undefined;

export class EcpParseError extends Error {
  override readonly name = 'EcpParseError';
}

function parse(xml: string, root: string): Record<string, unknown> {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch (err) {
    throw new EcpParseError(`Malformed XML: ${(err as Error).message}`);
  }
  const node = doc[root];
  if (node === undefined) throw new EcpParseError(`Expected <${root}> root element`);
  // An empty element (<apps/>) parses as "" — normalise to an empty object.
  return typeof node === 'object' && node !== null ? (node as Record<string, unknown>) : {};
}

function text(node: unknown): string | null {
  if (node === undefined || node === null) return null;
  if (typeof node === 'string') return node.trim() || null;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (typeof node === 'object' && '#text' in node) return text((node as { '#text'?: unknown })['#text']);
  return null;
}

function attr(node: XmlNode, name: string): string | null {
  if (!node || typeof node !== 'object') return null;
  const v = node[`@_${name}`];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function bool(v: string | null | undefined): boolean {
  return v?.toLowerCase() === 'true';
}

function toApp(node: XmlNode): RokuApp | null {
  const id = attr(node, 'id');
  const name = text(node);
  if (!id && !name) return null;
  return { id: id ?? '', name: name ?? id ?? '', type: attr(node, 'type'), version: attr(node, 'version') };
}

export function parseDeviceInfo(xml: string): DeviceInfo {
  const node = parse(xml, 'device-info');
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(node)) {
    const t = text(v);
    if (t !== null) raw[k] = t;
  }
  const get = (k: string): string | null => raw[k] ?? null;
  const macs = [normaliseMac(get('wifi-mac')), normaliseMac(get('ethernet-mac'))].filter(
    (m): m is string => m !== null,
  );
  return {
    serialNumber: get('serial-number'),
    deviceId: get('device-id'),
    name:
      get('user-device-name') ??
      get('friendly-device-name') ??
      get('default-device-name') ??
      get('friendly-model-name') ??
      get('model-name') ??
      'Roku',
    modelName: get('friendly-model-name') ?? get('model-name'),
    modelNumber: get('model-number'),
    vendorName: get('vendor-name'),
    softwareVersion: get('software-version'),
    powerMode: get('power-mode'),
    isTv: bool(get('is-tv')),
    developerEnabled: bool(get('developer-enabled')),
    macs,
    raw,
  };
}

/**
 * /query/active-app. The Home screen is reported as `<app>Roku</app>` (no id) on current
 * firmware; we also accept an explicit type="home"/"menu" in case newer firmware changes it.
 */
export function parseActiveApp(xml: string): ActiveApp {
  const node = parse(xml, 'active-app');
  const appNode = node.app as XmlNode;
  const app = toApp(appNode);
  const isHome = !app || app.id === '' || app.type === 'home' || app.type === 'menu';
  const ss = toApp(node.screensaver as XmlNode);
  return { app: isHome ? null : app, screensaver: ss };
}

export function parseApps(xml: string): RokuApp[] {
  const node = parse(xml, 'apps');
  const list = (node.app as XmlNode[] | undefined) ?? [];
  return list.map(toApp).filter((a): a is RokuApp => a !== null && a.id !== '');
}

function parseMs(v: string | null): number | null {
  if (!v) return null;
  const m = /^(-?\d+(?:\.\d+)?)\s*ms$/i.exec(v.trim());
  return m ? Math.round(Number(m[1])) : null;
}

export function parseMediaPlayer(xml: string): MediaPlayerState {
  const node = parse(xml, 'player') as Record<string, unknown> & XmlNode;
  const plugin = node.plugin as XmlNode;
  const isLive = text(node.is_live);
  return {
    state: attr(node, 'state'),
    error: bool(attr(node, 'error')),
    pluginId: attr(plugin, 'id'),
    pluginName: attr(plugin, 'name'),
    positionMs: parseMs(text(node.position)),
    durationMs: parseMs(text(node.duration)),
    isLive: isLive === null ? null : bool(isLive),
  };
}
