import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { Db } from '../db/database.js';
import type { KeyValueRepo } from '../db/repo.js';
import type { Clock } from '../lib/time.js';

/**
 * Dashboard authentication: a single household PIN (argon2id hash in the settings table) and
 * opaque session tokens (only their SHA-256 is stored). The PIN can only be *created* on the PC
 * (`npm run set-pin`), never from the dashboard, so a kid on the Wi-Fi can't claim it first.
 *
 * Brute force: the login route is rate-limited per IP, and after MAX_FAILURES consecutive wrong
 * PINs (from any IP) logins are locked for LOCKOUT_MS and `onLockout` fires (→ notification).
 */

export const PIN_PATTERN = /^\d{4,12}$/;
const PIN_KEY = 'auth.pinHash';
const MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60_000;

export class PinError extends Error {
  override readonly name = 'PinError';
}

export interface LoginResult {
  ok: boolean;
  token?: string;
  expiresAt?: number;
  lockedUntil?: number;
}

export class AuthService {
  private failures = 0;
  private lockedUntil = 0;

  constructor(
    private readonly db: Db,
    private readonly settings: KeyValueRepo,
    private readonly opts: { sessionDays: number },
    private readonly clock: Clock,
    private readonly onLockout?: (until: number) => void,
  ) {}

  isPinSet(): boolean {
    return this.settings.get<string>(PIN_KEY) !== null;
  }

  lockedUntilMs(): number | null {
    return this.lockedUntil > this.clock.now() ? this.lockedUntil : null;
  }

  /** Set or replace the PIN. Signs every existing dashboard session out. */
  async setPin(pin: string): Promise<void> {
    if (!PIN_PATTERN.test(pin)) throw new PinError('The PIN must be 4–12 digits.');
    const h = await hash(pin); // argon2id, library defaults (19 MiB, t=2)
    this.settings.set(PIN_KEY, h, this.clock.now());
    this.revokeAll();
  }

  async verifyPin(pin: string): Promise<boolean> {
    const stored = this.settings.get<string>(PIN_KEY)?.value;
    if (!stored || typeof pin !== 'string' || pin.length > 64) return false;
    try {
      return await verify(stored, pin);
    } catch {
      return false;
    }
  }

  async login(pin: string, meta: { ip: string; userAgent: string | undefined }): Promise<LoginResult> {
    const now = this.clock.now();
    if (this.lockedUntil > now) return { ok: false, lockedUntil: this.lockedUntil };
    if (!(await this.verifyPin(pin))) {
      this.failures++;
      if (this.failures >= MAX_FAILURES) {
        this.lockedUntil = now + LOCKOUT_MS;
        this.failures = 0;
        this.onLockout?.(this.lockedUntil);
        return { ok: false, lockedUntil: this.lockedUntil };
      }
      return { ok: false };
    }
    this.failures = 0;
    return { ok: true, ...this.createSession(meta) };
  }

  createSession(meta: { ip: string; userAgent: string | undefined }): { token: string; expiresAt: number } {
    const now = this.clock.now();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + this.opts.sessionDays * 86_400_000;
    this.db
      .prepare(
        'INSERT INTO auth_sessions (token_hash, created_at, expires_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(sha256(token), now, expiresAt, now, meta.ip, meta.userAgent?.slice(0, 200) ?? null);
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(now);
    return { token, expiresAt };
  }

  /** True if the token belongs to a live session (and refreshes its last-seen time). */
  validate(token: string | undefined): boolean {
    if (!token || token.length > 200) return false;
    const now = this.clock.now();
    const res = this.db
      .prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ? AND expires_at > ?')
      .run(now, sha256(token), now);
    return res.changes > 0;
  }

  revoke(token: string | undefined): void {
    if (token) this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(sha256(token));
  }

  revokeAll(): void {
    this.db.prepare('DELETE FROM auth_sessions').run();
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
