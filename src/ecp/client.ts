import http from 'node:http';
import {
  EcpError,
  type ActiveApp,
  type DeviceInfo,
  type EcpIcon,
  type EcpKey,
  type MediaPlayerState,
  type RokuApp,
} from './types.js';
import { EcpParseError, parseActiveApp, parseApps, parseDeviceInfo, parseMediaPlayer } from './xml.js';

export interface EcpClientOptions {
  host: string;
  port?: number;
  /** Hard deadline per request, covering connect + response. */
  timeoutMs?: number;
}

interface RawResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Minimal, dependency-free ECP client. Uses node:http directly (no keep-alive agent) because the
 * Roku's embedded HTTP server is simple, and so network failures map to precise error kinds:
 *   - refused     ECONNREFUSED — host is up but nothing on 8060 (ECP disabled, or wrong device at this IP)
 *   - unreachable no route / reset / DNS
 *   - timeout     our deadline elapsed (typical when the TV is fully powered down)
 *   - restricted  HTTP 401/403 — "Control by mobile apps" is not set to Enabled
 */
export class EcpClient {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;

  constructor(opts: EcpClientOptions) {
    this.host = opts.host;
    this.port = opts.port ?? 8060;
    this.timeoutMs = opts.timeoutMs ?? 2500;
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  async deviceInfo(): Promise<DeviceInfo> {
    return this.parse('/query/device-info', parseDeviceInfo);
  }

  async activeApp(): Promise<ActiveApp> {
    return this.parse('/query/active-app', parseActiveApp);
  }

  async apps(): Promise<RokuApp[]> {
    return this.parse('/query/apps', parseApps);
  }

  async mediaPlayer(): Promise<MediaPlayerState> {
    return this.parse('/query/media-player', parseMediaPlayer);
  }

  /** Channel/input icon. Blocked unless "Control by mobile apps" is Enabled (Roku OS 14.1+). */
  async icon(appId: string): Promise<EcpIcon> {
    const res = await this.request('GET', `/query/icon/${encodeURIComponent(appId)}`);
    return { contentType: res.contentType || 'application/octet-stream', data: res.body };
  }

  async keypress(key: EcpKey): Promise<void> {
    await this.request('POST', `/keypress/${encodeURIComponent(key)}`);
  }

  /** Launch a channel (`dev` = sideloaded dev channel). Params are passed to the channel's main(). */
  async launch(appId: string, params?: Record<string, string>): Promise<void> {
    const qs = params && Object.keys(params).length ? `?${new URLSearchParams(params).toString()}` : '';
    await this.request('POST', `/launch/${encodeURIComponent(appId)}${qs}`);
  }

  /** Send parameters to the channel that is running now (it receives an roInputEvent). */
  async input(params: Record<string, string>): Promise<void> {
    await this.request('POST', `/input?${new URLSearchParams(params).toString()}`);
  }

  private async parse<T>(path: string, parser: (xml: string) => T): Promise<T> {
    const res = await this.request('GET', path);
    try {
      return parser(res.body.toString('utf8'));
    } catch (err) {
      if (err instanceof EcpParseError) {
        throw new EcpError('parse', `${path}: ${err.message}`, { endpoint: path, status: res.status });
      }
      throw err;
    }
  }

  private request(method: 'GET' | 'POST', path: string): Promise<RawResponse> {
    return new Promise<RawResponse>((resolve, reject) => {
      let settled = false;
      const fail = (err: EcpError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        req.destroy();
        reject(err);
      };

      const req = http.request({
        host: this.host,
        port: this.port,
        path,
        method,
        agent: false,
        headers: method === 'POST' ? { 'Content-Length': '0' } : { Accept: '*/*' },
      });

      const deadline = setTimeout(() => {
        fail(new EcpError('timeout', `${method} ${path}: no response within ${this.timeoutMs}ms`, { endpoint: path }));
      }, this.timeoutMs);

      req.on('error', (err: NodeJS.ErrnoException) => {
        const code = err.code ?? 'UNKNOWN';
        // Anything other than a refusal (EHOSTUNREACH, ETIMEDOUT, ECONNRESET, ENOTFOUND, …) = unreachable.
        const kind = code === 'ECONNREFUSED' ? 'refused' : 'unreachable';
        fail(new EcpError(kind, `${method} ${path}: ${code} (${this.host}:${this.port})`, { endpoint: path, code }));
      });

      req.on('response', (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            fail(
              new EcpError('http', `${method} ${path}: response too large`, { endpoint: path, status: res.statusCode }),
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', (err: NodeJS.ErrnoException) => {
          fail(new EcpError('unreachable', `${method} ${path}: ${err.message}`, { endpoint: path, code: err.code }));
        });
        res.on('end', () => {
          if (settled) return;
          const status = res.statusCode ?? 0;
          if (status === 401 || status === 403) {
            fail(
              new EcpError('restricted', `${method} ${path}: HTTP ${status} — ECP access restricted on the TV`, {
                endpoint: path,
                status,
              }),
            );
            return;
          }
          if (status < 200 || status >= 300) {
            fail(new EcpError('http', `${method} ${path}: HTTP ${status}`, { endpoint: path, status }));
            return;
          }
          settled = true;
          clearTimeout(deadline);
          resolve({ status, contentType: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks) });
        });
      });

      req.end();
    });
  }
}
