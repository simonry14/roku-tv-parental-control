import { createHash, randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { listZipEntries, readZipEntry } from '../src/channel/zip.js';
import { SSDP_ADDRESS, SSDP_PORT, parseSsdpMessage } from '../src/ecp/discovery.js';
import type { PowerMode, RokuApp } from '../src/ecp/types.js';
import { DEFAULT_APPS, DEV_CHANNEL, SCREENSAVER, iconSvg } from './fixtures.js';
import { CONTROL_PANEL_HTML } from './panel.js';

/**
 * Mock Roku TV implementing the ECP subset Roku TV Parental Control uses, plus a control API/panel to
 * play "the kid with the remote": power, app switching, screensaver, and the three
 * "Control by mobile apps" modes.
 *
 *   ECP        http://<host>:8060   (what the service talks to)
 *   Control    http://<host>:8061   (panel + JSON API: GET/POST /api/state, GET /api/history)
 *   SSDP       udp 1900             (answers M-SEARCH ST: roku:ecp)
 *
 * Access modes mirror Roku OS 14.1+:
 *   enabled   everything works
 *   limited   queries work; keypress/keydown/keyup/query/icon → 403
 *   disabled  every ECP request → 403, SSDP still answers (observed on a real Roku TV, 2026-09-30);
 *             --disabled-behavior refuse closes port 8060 instead (other firmware may do this)
 * `offline` makes the TV accept connections but never answer (→ client timeouts), and go
 * silent on SSDP — like a TV that has been unplugged.
 *
 * The "Time's up" dev channel: /launch/dev?… and /input?… store their parameters in
 * `state.devMessage` (decoded in the panel), Select on a dismissable message closes it, and the
 * optional developer installer (`devInstaller`, Digest auth like the real one) accepts uploads.
 */

export type AccessMode = 'enabled' | 'limited' | 'disabled';

export interface MockState {
  serial: string;
  name: string;
  model: string;
  softwareVersion: string;
  wifiMac: string;
  power: PowerMode;
  /** null = Home screen */
  activeAppId: string | null;
  screensaver: boolean;
  access: AccessMode;
  offline: boolean;
  latencyMs: number;
  devChannelInstalled: boolean;
  /** major.minor.build of the sideloaded channel (from its manifest). */
  devChannelVersion: string;
  /** Parameters of the message the dev channel is showing (launch or input), or null. */
  devMessage: Record<string, string> | null;
  apps: RokuApp[];
}

export interface MockCommand {
  at: number;
  method: string;
  path: string;
  /** Query parameters (launch/input). */
  query: Record<string, string>;
  status: number;
}

export interface MockRokuOptions {
  /** Bind address for ECP + control servers. Default 0.0.0.0. */
  host?: string;
  /** ECP port. Default 8060; 0 = random (tests). */
  ecpPort?: number;
  /** Control API/panel port. Default 8061; 0 = random; null = disabled. */
  controlPort?: number | null;
  /** SSDP responder. false = off. Default port 1900. */
  ssdp?: false | { port?: number; advertiseHost?: string };
  /** How "disabled" access behaves: answer 403 (default — what real Roku TVs do) or refuse TCP connections. */
  disabledBehavior?: 'refuse' | '403';
  /** Developer web installer (port 80 on a real TV). 0 = random port; omitted = off. */
  devInstaller?: { port: number; password: string };
  initial?: Partial<MockState>;
  quiet?: boolean;
}

export interface MockRoku {
  readonly state: MockState;
  readonly history: MockCommand[];
  readonly ecpPort: number;
  readonly controlPort: number | null;
  readonly ssdpPort: number | null;
  readonly devInstallerPort: number | null;
  /** Channel packages uploaded to the developer installer, newest last. */
  readonly sideloads: Array<{ at: number; bytes: number; entries: string[] }>;
  readonly ecpUrl: string;
  /** Apply a state change (handles listener stop/start for access=disabled). */
  set(patch: Partial<MockState>): Promise<void>;
  /** Simulate the kid's remote: same semantics as ECP keypress/launch, but not recorded in history. */
  remote(action: { key?: string; launch?: string }): void;
  reset(): Promise<void>;
  close(): Promise<void>;
}

const XML_HEADERS = { 'Content-Type': 'text/xml; charset="utf-8"', Server: 'Roku/14.1.4 UPnP/1.0 Roku/14.1.4' };

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function defaultState(): MockState {
  return {
    serial: 'YJ00MOCK0001',
    name: 'Living Room TV (mock)',
    model: 'Roku TV 55" (mock)',
    softwareVersion: '14.1.4',
    wifiMac: 'd8:31:34:00:be:ef',
    power: 'PowerOn',
    activeAppId: null,
    screensaver: false,
    access: 'enabled',
    offline: false,
    latencyMs: 0,
    devChannelInstalled: true,
    devChannelVersion: DEV_CHANNEL.version ?? '1.0.0',
    devMessage: null,
    apps: structuredClone(DEFAULT_APPS),
  };
}

function lanAddress(): string {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? [])
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address;
  }
  return '127.0.0.1';
}

export async function startMockRoku(opts: MockRokuOptions = {}): Promise<MockRoku> {
  const bindHost = opts.host ?? '0.0.0.0';
  const disabledBehavior = opts.disabledBehavior ?? '403';
  const log = (...args: unknown[]): void => {
    if (!opts.quiet) console.log(new Date().toISOString().slice(11, 23), ...args);
  };

  let state: MockState = { ...defaultState(), ...opts.initial };
  const history: MockCommand[] = [];
  const sideloads: Array<{ at: number; bytes: number; entries: string[]; sha: string }> = [];
  const devChannel = (): RokuApp => ({ ...DEV_CHANNEL, version: state.devChannelVersion });
  const findApp = (id: string | null): RokuApp | undefined =>
    id === null
      ? undefined
      : id === 'dev' && state.devChannelInstalled
        ? devChannel()
        : state.apps.find((a) => a.id === id);

  // ─── ECP behaviour ──────────────────────────────────────────────────────

  const applyKey = (key: string): void => {
    switch (key) {
      case 'Home':
      case 'Back':
        if (state.power === 'PowerOn') {
          state.activeAppId = null;
          state.screensaver = false;
          state.devMessage = null;
        }
        break;
      case 'Select':
        // OK on a dismissable "Time's up" message closes the channel (→ Home).
        if (state.activeAppId === 'dev' && state.devMessage?.ok !== '0') {
          state.activeAppId = null;
          state.devMessage = null;
        }
        if (state.screensaver) state.screensaver = false;
        break;
      case 'PowerOff':
        state.power = 'DisplayOff';
        state.activeAppId = null;
        state.screensaver = false;
        state.devMessage = null;
        break;
      case 'PowerOn':
        state.power = 'PowerOn';
        break;
      case 'Power':
        applyKey(state.power === 'PowerOn' ? 'PowerOff' : 'PowerOn');
        break;
      default:
        if (state.screensaver) state.screensaver = false; // any key dismisses the screensaver
    }
  };

  const applyLaunch = (id: string, params: Record<string, string> = {}): boolean => {
    if (!findApp(id)) return false;
    state.power = 'PowerOn';
    state.activeAppId = id;
    state.screensaver = false;
    state.devMessage = id === 'dev' ? params : null;
    return true;
  };

  const deviceInfoXml = (): string => `<?xml version="1.0" encoding="UTF-8" ?>
<device-info>
  <udn>28001240-0000-1000-8000-${state.wifiMac.replace(/:/g, '')}</udn>
  <serial-number>${esc(state.serial)}</serial-number>
  <device-id>${esc(state.serial)}</device-id>
  <vendor-name>Mock</vendor-name>
  <model-name>${esc(state.model)}</model-name>
  <model-number>7000X</model-number>
  <friendly-model-name>${esc(state.model)}</friendly-model-name>
  <is-tv>true</is-tv>
  <is-stick>false</is-stick>
  <supports-ethernet>true</supports-ethernet>
  <wifi-mac>${state.wifiMac}</wifi-mac>
  <ethernet-mac>00:00:00:00:00:00</ethernet-mac>
  <network-type>wifi</network-type>
  <friendly-device-name>${esc(state.name)}</friendly-device-name>
  <user-device-name>${esc(state.name)}</user-device-name>
  <software-version>${state.softwareVersion}</software-version>
  <software-build>4217</software-build>
  <power-mode>${state.power}</power-mode>
  <supports-suspend>false</supports-suspend>
  <developer-enabled>${state.devChannelInstalled}</developer-enabled>
  <time-zone-tz>America/New_York</time-zone-tz>
</device-info>
`;

  const appXml = (a: RokuApp, tag = 'app'): string =>
    `<${tag} id="${esc(a.id)}" type="${esc(a.type ?? 'appl')}" version="${esc(a.version ?? '1.0.0')}">${esc(a.name)}</${tag}>`;

  const activeAppXml = (): string => {
    const app = findApp(state.activeAppId);
    const appPart = app ? appXml(app) : '<app>Roku</app>';
    const ss = state.screensaver ? `\n  ${appXml(SCREENSAVER, 'screensaver')}` : '';
    return `<?xml version="1.0" encoding="UTF-8" ?>\n<active-app>\n  ${appPart}${ss}\n</active-app>\n`;
  };

  const appsXml = (): string => {
    const list = [...state.apps, ...(state.devChannelInstalled ? [devChannel()] : [])];
    return `<?xml version="1.0" encoding="UTF-8" ?>\n<apps>\n${list.map((a) => `  ${appXml(a)}`).join('\n')}\n</apps>\n`;
  };

  const mediaPlayerXml = (): string => {
    const app = state.power === 'PowerOn' ? findApp(state.activeAppId) : undefined;
    if (!app || app.type !== 'appl')
      return '<?xml version="1.0" encoding="UTF-8" ?>\n<player error="false" state="close"/>\n';
    return `<?xml version="1.0" encoding="UTF-8" ?>
<player error="false" state="play">
  <plugin bandwidth="18000000 bps" id="${esc(app.id)}" name="${esc(app.name)}"/>
  <format audio="aac_adts" captions="none" drm="none" video="mpeg4_10b" video_res="1920x1080"/>
  <position>${(Date.now() % 3_600_000).toString()} ms</position>
  <duration>3600000 ms</duration>
  <is_live>false</is_live>
</player>
`;
  };

  const send = (
    res: http.ServerResponse,
    status: number,
    body = '',
    headers: Record<string, string> = XML_HEADERS,
  ): void => {
    res.writeHead(status, { ...headers, 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };

  const handleEcp = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (state.offline) {
      // Swallow the request; the client's deadline fires, just like an unplugged TV.
      req.socket.setTimeout(30_000, () => req.socket.destroy());
      return;
    }
    if (state.latencyMs > 0) await new Promise((r) => setTimeout(r, state.latencyMs));

    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://mock');
    const path = url.pathname;
    const query = Object.fromEntries(url.searchParams);
    const record = (status: number): void => {
      if (method !== 'GET') {
        history.push({ at: Date.now(), method, path, query, status });
        if (history.length > 1000) history.shift();
        log(`ECP ${method} ${path} → ${status}`);
      }
    };

    if (state.access === 'disabled') {
      record(403);
      return send(res, 403);
    }
    const controlBlocked = state.access === 'limited';
    let m: RegExpExecArray | null;

    if (method === 'GET') {
      if (path === '/query/device-info') return send(res, 200, deviceInfoXml());
      if (path === '/query/active-app') return send(res, 200, activeAppXml());
      if (path === '/query/apps') return send(res, 200, appsXml());
      if (path === '/query/media-player') return send(res, 200, mediaPlayerXml());
      if ((m = /^\/query\/icon\/(.+)$/.exec(path))) {
        if (controlBlocked) return send(res, 403);
        const app = findApp(decodeURIComponent(m[1]!));
        if (!app) return send(res, 404);
        return send(res, 200, iconSvg(app), { 'Content-Type': 'image/svg+xml' });
      }
      if (path === '/')
        return send(
          res,
          200,
          '<?xml version="1.0"?><root><device><deviceType>urn:roku-com:device:player:1-0</deviceType></device></root>',
        );
      return send(res, 404);
    }

    if (method === 'POST') {
      if ((m = /^\/(keypress|keydown|keyup)\/(.+)$/.exec(path))) {
        if (controlBlocked) {
          record(403);
          return send(res, 403);
        }
        if (m[1] === 'keypress') applyKey(decodeURIComponent(m[2]!));
        record(200);
        return send(res, 200);
      }
      if ((m = /^\/launch\/(.+)$/.exec(path))) {
        if (controlBlocked) {
          record(403);
          return send(res, 403);
        }
        const ok = applyLaunch(decodeURIComponent(m[1]!), query);
        record(ok ? 200 : 404);
        return send(res, ok ? 200 : 404);
      }
      if (path === '/input') {
        // Delivered to the running channel as an roInputEvent; our channel shows it as a new message.
        if (state.activeAppId === 'dev') state.devMessage = query;
        record(200);
        return send(res, 200);
      }
      record(404);
      return send(res, 404);
    }
    return send(res, 405);
  };

  // ─── ECP listener (can be stopped/started to emulate "disabled → refused") ─

  const ecpServer = http.createServer((req, res) => {
    handleEcp(req, res).catch((err: unknown) => {
      log('ECP handler error', err);
      if (!res.headersSent) send(res, 500);
    });
  });
  let ecpListening = false;
  let ecpPort = opts.ecpPort ?? 8060;

  const listenEcp = async (): Promise<void> => {
    if (ecpListening) return;
    await new Promise<void>((resolve, reject) => {
      ecpServer.once('error', reject);
      ecpServer.listen(ecpPort, bindHost, () => {
        ecpServer.off('error', reject);
        resolve();
      });
    });
    ecpPort = (ecpServer.address() as AddressInfo).port;
    ecpListening = true;
  };
  const closeEcp = async (): Promise<void> => {
    if (!ecpListening) return;
    ecpListening = false;
    ecpServer.closeAllConnections();
    await new Promise<void>((resolve) => ecpServer.close(() => resolve()));
  };
  const shouldListen = (): boolean => !(state.access === 'disabled' && disabledBehavior === 'refuse');

  if (shouldListen()) await listenEcp();
  else {
    // Reserve the port number by listening once, then close.
    await listenEcp();
    await closeEcp();
  }

  // ─── SSDP responder ─────────────────────────────────────────────────────

  let ssdpSocket: dgram.Socket | null = null;
  let ssdpPort: number | null = null;
  const advertiseHost = (opts.ssdp && opts.ssdp.advertiseHost) || (bindHost !== '0.0.0.0' ? bindHost : lanAddress());
  if (opts.ssdp !== false) {
    const wanted = (opts.ssdp && opts.ssdp.port) ?? SSDP_PORT;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('message', (msg, rinfo) => {
      const parsed = parseSsdpMessage(msg.toString('utf8'));
      if (!parsed || !/^M-SEARCH\s/i.test(parsed.startLine) || state.offline) return;
      const st = (parsed.headers.st ?? '').toLowerCase();
      if (st !== 'roku:ecp' && st !== 'ssdp:all') return;
      const reply = [
        'HTTP/1.1 200 OK',
        'Cache-Control: max-age=3600',
        'ST: roku:ecp',
        `USN: uuid:roku:ecp:${state.serial}`,
        'Ext: ',
        'Server: Roku/14.1.4 UPnP/1.0 Roku/14.1.4',
        `LOCATION: http://${advertiseHost}:${ecpPort}/`,
        '',
        '',
      ].join('\r\n');
      setTimeout(() => sock.send(reply, rinfo.port, rinfo.address), 20 + Math.floor(Math.random() * 150));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        sock.once('error', reject);
        sock.bind(wanted, () => {
          sock.off('error', reject);
          resolve();
        });
      });
      try {
        sock.addMembership(SSDP_ADDRESS);
      } catch (err) {
        log(`SSDP: could not join multicast group (${(err as Error).message}); unicast M-SEARCH still works`);
      }
      ssdpSocket = sock;
      ssdpPort = sock.address().port;
    } catch (err) {
      log(
        `SSDP responder disabled: cannot bind UDP ${wanted} (${(err as Error).message}). On Windows the "SSDP Discovery" service may hold it; use device.host instead.`,
      );
      sock.close();
    }
  }

  // ─── Control API + panel ────────────────────────────────────────────────

  const api: MockRoku = {
    get state() {
      return state;
    },
    history,
    get ecpPort() {
      return ecpPort;
    },
    controlPort: null,
    ssdpPort,
    devInstallerPort: null,
    sideloads,
    get ecpUrl() {
      return `http://${bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost}:${ecpPort}`;
    },
    async set(patch) {
      const before = { access: state.access, power: state.power, app: state.activeAppId, offline: state.offline };
      state = { ...state, ...patch };
      if (patch.activeAppId !== undefined && patch.activeAppId !== null && !findApp(patch.activeAppId)) {
        state.activeAppId = before.app;
        throw new Error(`Unknown app id ${patch.activeAppId}`);
      }
      if (patch.activeAppId && patch.power === undefined) state.power = 'PowerOn';
      if (patch.power && patch.power !== 'PowerOn') {
        state.activeAppId = null;
        state.screensaver = false;
      }
      if (shouldListen()) await listenEcp();
      else await closeEcp();
      log(
        'State:',
        JSON.stringify({
          power: state.power,
          app: state.activeAppId,
          screensaver: state.screensaver,
          access: state.access,
          offline: state.offline,
        }),
      );
    },
    remote(action) {
      if (action.key) applyKey(action.key);
      if (action.launch && !applyLaunch(action.launch)) throw new Error(`Unknown app id ${action.launch}`);
      log('Remote:', JSON.stringify(action), '→', JSON.stringify({ power: state.power, app: state.activeAppId }));
    },
    async reset() {
      await api.set({ ...defaultState(), ...opts.initial });
      history.length = 0;
    },
    async close() {
      await closeEcp();
      ecpServer.close();
      ssdpSocket?.close();
      if (installerServer) {
        installerServer.closeAllConnections();
        await new Promise<void>((resolve) => installerServer!.close(() => resolve()));
      }
      if (controlServer) {
        controlServer.closeAllConnections();
        await new Promise<void>((resolve) => controlServer!.close(() => resolve()));
      }
    },
  };

  // ─── Developer installer (http://<tv>/plugin_install, Digest auth) ──────
  let installerServer: http.Server | null = null;
  if (opts.devInstaller) {
    const { password } = opts.devInstaller;
    const realm = 'rokudev';
    const nonces = new Set<string>();
    const md5 = (v: string): string => createHash('md5').update(v).digest('hex');
    const challenge = (res: http.ServerResponse): void => {
      const nonce = randomBytes(16).toString('hex');
      nonces.add(nonce);
      res.writeHead(401, { 'WWW-Authenticate': `Digest qop="auth", realm="${realm}", nonce="${nonce}"` });
      res.end();
    };
    const authorized = (req: http.IncomingMessage): boolean => {
      const h = req.headers.authorization ?? '';
      if (!h.startsWith('Digest ')) return false;
      const p: Record<string, string> = {};
      for (const m of h.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)) p[m[1]!] = m[2] ?? m[3] ?? '';
      if (p.username !== 'rokudev' || !p.nonce || !nonces.has(p.nonce)) return false;
      const ha1 = md5(`rokudev:${realm}:${password}`);
      const ha2 = md5(`${req.method}:${p.uri}`);
      return p.response === md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
    };
    const page = (message: string, type: 'success' | 'error'): string =>
      `<html><body><script>Shell.create('Roku.Message').trigger('Set message type', '${type}').trigger('Set message content', '${message}').render();</script></body></html>`;
    installerServer = http.createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        if (!authorized(req)) return challenge(res);
        if (req.method !== 'POST' || !req.url?.startsWith('/plugin_install')) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          return res.end(page('Development Application Installer', 'success'));
        }
        const body = Buffer.concat(chunks);
        const boundary = /boundary=(.+)$/.exec(String(req.headers['content-type']))?.[1];
        const start = body.indexOf('PK\x03\x04', 0, 'latin1');
        const end = boundary ? body.lastIndexOf(`\r\n--${boundary}`, undefined, 'latin1') : -1;
        const zip = start >= 0 && end > start ? body.subarray(start, end) : Buffer.alloc(0);
        const entries = ((): string[] => {
          try {
            return listZipEntries(zip);
          } catch {
            return [];
          }
        })();
        res.writeHead(200, { 'Content-Type': 'text/html' });
        if (!entries.includes('manifest'))
          return res.end(page('Install Failure: No manifest. Invalid package.', 'error'));
        const sha = createHash('sha256').update(zip).digest('hex');
        const identical = state.devChannelInstalled && sideloads.at(-1)?.sha === sha;
        sideloads.push({ at: Date.now(), bytes: zip.length, entries, sha });
        const manifest = readZipEntry(zip, 'manifest')?.toString('utf8') ?? '';
        const part = (k: string): string => new RegExp(`^${k}=(\\d+)`, 'm').exec(manifest)?.[1] ?? '0';
        state.devChannelVersion = `${part('major_version')}.${part('minor_version')}.${part('build_version')}`;
        state.devChannelInstalled = true;
        applyLaunch('dev'); // a real TV starts the channel right after installing it
        log(`Sideloaded channel (${zip.length} bytes, ${entries.length} files)`);
        res.end(page(identical ? 'Identical to previous version -- not replacing.' : 'Install Success.', 'success'));
      })().catch(() => {
        res.writeHead(500);
        res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      installerServer!.once('error', reject);
      installerServer!.listen(opts.devInstaller!.port, bindHost, () => resolve());
    });
    (api as { devInstallerPort: number | null }).devInstallerPort = (installerServer.address() as AddressInfo).port;
  }

  let controlServer: http.Server | null = null;
  if (opts.controlPort !== null) {
    controlServer = http.createServer((req, res) => {
      void handleControl(req, res);
    });
    const handleControl = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
      const json = (status: number, body: unknown): void =>
        send(res, status, JSON.stringify(body, null, 2), { 'Content-Type': 'application/json' });
      const path = new URL(req.url ?? '/', 'http://mock').pathname;
      try {
        if (req.method === 'GET' && path === '/')
          return send(res, 200, CONTROL_PANEL_HTML, { 'Content-Type': 'text/html; charset=utf-8' });
        if (req.method === 'GET' && path === '/api/state')
          return json(200, {
            ...state,
            ecpPort,
            ssdpPort,
            ecpListening,
            apps: [...state.apps, ...(state.devChannelInstalled ? [devChannel()] : [])],
          });
        if (req.method === 'GET' && path === '/api/history') return json(200, history.slice(-200));
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const body = chunks.length
            ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
            : {};
          if (path === '/api/state') {
            await api.set(body as Partial<MockState>);
            return json(200, state);
          }
          if (path === '/api/remote') {
            api.remote(body as { key?: string; launch?: string });
            return json(200, state);
          }
          if (path === '/api/reset') {
            await api.reset();
            return json(200, state);
          }
        }
        return json(404, { error: 'not found' });
      } catch (err) {
        return json(400, { error: (err as Error).message });
      }
    };
    await new Promise<void>((resolve, reject) => {
      controlServer!.once('error', reject);
      controlServer!.listen(opts.controlPort ?? 8061, bindHost, () => resolve());
    });
    (api as { controlPort: number | null }).controlPort = (controlServer.address() as AddressInfo).port;
  }

  return api;
}

// ─── CLI ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      host: { type: 'string', default: '0.0.0.0' },
      port: { type: 'string', default: '8060' },
      'control-port': { type: 'string', default: '8061' },
      'ssdp-port': { type: 'string', default: String(SSDP_PORT) },
      'no-ssdp': { type: 'boolean', default: false },
      'advertise-host': { type: 'string' },
      serial: { type: 'string' },
      name: { type: 'string' },
      'disabled-behavior': { type: 'string', default: '403' },
      'dev-installer-port': { type: 'string', default: '8062' },
      'dev-password': { type: 'string', default: 'mock' },
      power: { type: 'string' },
      app: { type: 'string' },
      access: { type: 'string' },
    },
  });

  const initial: Partial<MockState> = {};
  if (values.serial) initial.serial = values.serial;
  if (values.name) initial.name = values.name;
  if (values.power) initial.power = values.power;
  if (values.app) initial.activeAppId = values.app;
  if (values.access) initial.access = values.access as AccessMode;

  const mock = await startMockRoku({
    host: values.host,
    ecpPort: Number(values.port),
    controlPort: Number(values['control-port']),
    ssdp: values['no-ssdp']
      ? false
      : {
          port: Number(values['ssdp-port']),
          ...(values['advertise-host'] ? { advertiseHost: values['advertise-host'] } : {}),
        },
    disabledBehavior: values['disabled-behavior'] === 'refuse' ? 'refuse' : '403',
    devInstaller: { port: Number(values['dev-installer-port']), password: values['dev-password'] },
    initial,
  });

  const shown = values.host === '0.0.0.0' ? 'localhost' : values.host;
  console.log(`
  Mock Roku TV "${mock.state.name}"  serial ${mock.state.serial}
    ECP      http://${shown}:${mock.ecpPort}/query/device-info
    Control  http://${shown}:${mock.controlPort}/   (panel)   ·   GET|POST /api/state   ·   GET /api/history
    SSDP     ${mock.ssdpPort ? `udp ${mock.ssdpPort}` : 'off'}
    Sideload http://${shown}:${mock.devInstallerPort}/plugin_install   (user rokudev, password "${values['dev-password']}")
  Point the service at it with config.mock.json (npm run dev:mock). Ctrl+C to stop.
`);

  const stop = async (): Promise<void> => {
    await mock.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
