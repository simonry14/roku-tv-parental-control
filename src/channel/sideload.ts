import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';

/**
 * Installs a channel package on a Roku in developer mode, the same way the TV's web page at
 * http://<tv-ip>/ does: POST /plugin_install (multipart) with HTTP Digest auth, user "rokudev".
 */

export interface SideloadOptions {
  host: string;
  /** The developer web installer listens on port 80. */
  port?: number;
  username?: string;
  password: string;
  zip: Buffer;
  timeoutMs?: number;
}

export interface SideloadResult {
  /** installed = new package; identical = the same package was already installed. */
  status: 'installed' | 'identical';
  message: string;
}

export class SideloadError extends Error {
  override readonly name = 'SideloadError';
  constructor(
    readonly kind: 'unreachable' | 'auth' | 'rejected' | 'http',
    message: string,
  ) {
    super(message);
  }
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  opts: { host: string; port: number; method: string; path: string; headers?: Record<string, string | number> },
  body: Buffer | null,
  timeoutMs: number,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: opts.host, port: opts.port, method: opts.method, path: opts.path, headers: opts.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no response within ${timeoutMs} ms`)));
    req.on('error', (err: NodeJS.ErrnoException) => {
      const hint =
        err.code === 'ECONNREFUSED'
          ? ' Developer mode looks switched off on the TV (nothing is listening on port 80).'
          : '';
      reject(
        new SideloadError(
          'unreachable',
          `Could not reach ${opts.host}:${opts.port}: ${err.code ?? err.message}.${hint}`,
        ),
      );
    });
    req.end(body ?? undefined);
  });
}

// ─── HTTP Digest (RFC 7616; MD5 and SHA-256, qop=auth or legacy) ──────────────

export interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  algorithm?: string;
  opaque?: string;
}

export function parseDigestChallenge(header: string | undefined): DigestChallenge | null {
  if (!header || !/^\s*Digest\s/i.test(header)) return null;
  const params: Record<string, string> = {};
  for (const m of header
    .replace(/^\s*Digest\s+/i, '')
    .matchAll(/([a-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/gi)) {
    params[m[1]!.toLowerCase()] = (m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
  }
  if (!params.realm || !params.nonce) return null;
  return {
    realm: params.realm,
    nonce: params.nonce,
    ...(params.qop ? { qop: params.qop } : {}),
    ...(params.algorithm ? { algorithm: params.algorithm } : {}),
    ...(params.opaque ? { opaque: params.opaque } : {}),
  };
}

export function digestAuthorization(
  ch: DigestChallenge,
  req: { method: string; uri: string; username: string; password: string; cnonce?: string; nc?: number },
): string {
  const algorithm = (ch.algorithm ?? 'MD5').toUpperCase();
  const hashName = algorithm.startsWith('SHA-256') ? 'sha256' : 'md5';
  const h = (s: string): string => createHash(hashName).update(s).digest('hex');
  const cnonce = req.cnonce ?? randomBytes(8).toString('hex');
  const nc = (req.nc ?? 1).toString(16).padStart(8, '0');
  let ha1 = h(`${req.username}:${ch.realm}:${req.password}`);
  if (algorithm.endsWith('-SESS')) ha1 = h(`${ha1}:${ch.nonce}:${cnonce}`);
  const ha2 = h(`${req.method}:${req.uri}`);
  const qop = ch.qop
    ?.split(',')
    .map((s) => s.trim())
    .includes('auth')
    ? 'auth'
    : undefined;
  const response = qop ? h(`${ha1}:${ch.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : h(`${ha1}:${ch.nonce}:${ha2}`);
  const parts = [
    `username="${req.username}"`,
    `realm="${ch.realm}"`,
    `nonce="${ch.nonce}"`,
    `uri="${req.uri}"`,
    `response="${response}"`,
  ];
  if (ch.algorithm) parts.push(`algorithm=${ch.algorithm}`);
  if (ch.opaque) parts.push(`opaque="${ch.opaque}"`);
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return `Digest ${parts.join(', ')}`;
}

// ─── Upload ───────────────────────────────────────────────────────────────────

function multipart(zip: Buffer): { body: Buffer; contentType: string } {
  const boundary = `----RokuTVParentalControl${randomBytes(12).toString('hex')}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="mysubmit"\r\n\r\nInstall\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="parental-control-channel.zip"\r\n` +
        `Content-Type: application/zip\r\n\r\n`,
    ),
    zip,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** The installer's verdict, from its HTML (old firmware) or its inline script (newer firmware). */
export function parseInstallerResponse(html: string): SideloadResult | { status: 'failed'; message: string } {
  const messages = [
    ...[...html.matchAll(/'Set message content',\s*'([^']*)'/g)].map((m) => m[1]!),
    ...[...html.matchAll(/<font[^>]*>([^<]*)<\/font>/gi)].map((m) => m[1]!),
  ]
    .map((s) => s.trim())
    .filter(Boolean);
  const text =
    messages.join(' ') ||
    html
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
  if (/identical to previous version/i.test(text)) return { status: 'identical', message: text };
  if (/install success|application received/i.test(text)) return { status: 'installed', message: text };
  return { status: 'failed', message: text || 'The TV did not say whether the install worked' };
}

export async function sideloadChannel(opts: SideloadOptions): Promise<SideloadResult> {
  const port = opts.port ?? 80;
  const username = opts.username ?? 'rokudev';
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const path = '/plugin_install';

  // 1. Unauthenticated request to get the Digest challenge (cheap: no upload yet).
  const probe = await request({ host: opts.host, port, method: 'GET', path }, null, 10_000);
  const challenge = parseDigestChallenge(
    ([] as string[]).concat(probe.headers['www-authenticate'] ?? []).find((h) => /^\s*Digest/i.test(h)),
  );
  if (!challenge) {
    throw new SideloadError(
      'http',
      `The TV's developer installer did not ask for a password (HTTP ${probe.status}). Is this a Roku in developer mode?`,
    );
  }

  // 2. The upload, authenticated.
  const { body, contentType } = multipart(opts.zip);
  const res = await request(
    {
      host: opts.host,
      port,
      method: 'POST',
      path,
      headers: {
        Authorization: digestAuthorization(challenge, { method: 'POST', uri: path, username, password: opts.password }),
        'Content-Type': contentType,
        'Content-Length': body.length,
      },
    },
    body,
    timeoutMs,
  );
  if (res.status === 401) {
    throw new SideloadError('auth', 'The TV rejected the developer password. Check ROKU_DEV_PASSWORD in .env.');
  }
  if (res.status < 200 || res.status >= 300) {
    throw new SideloadError('http', `The TV answered HTTP ${res.status} to the upload`);
  }
  const verdict = parseInstallerResponse(res.body);
  if (verdict.status === 'failed')
    throw new SideloadError('rejected', `The TV did not install the channel: ${verdict.message}`);
  return verdict;
}
