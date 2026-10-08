import type { NewSession, Repos, SessionEndReason, SessionKind, SessionRecord } from '../db/repo.js';
import type { Observation } from './observation.js';

/**
 * Session accounting.
 *
 * Invariant: counted time is the sum, over consecutive poll pairs, of the interval between them
 * *only when both polls saw the same activity and were at most `maxGapMs` apart*. Therefore:
 *   - a session starts at the poll that first saw it,
 *   - it is extended (`last_seen_at`) by each poll that sees it again within `maxGapMs`,
 *   - it always ends at its last confirmed poll (`ended_at = last_seen_at`) — on app switch,
 *     power-off, gap, unreachable, restart…
 * Unobserved time (PC asleep, TV unreachable, service down) is never counted, and because a new
 * session only opens after the previous one is closed (and the DB allows a single open row),
 * nothing is ever counted twice. The cost is ≤ one poll interval of under-count per transition.
 *
 * `planSessionOps` is pure; `SessionTracker` applies the plan transactionally.
 */

export interface OpenSessionView {
  id: number;
  deviceSerial: string;
  kind: SessionKind;
  appId: string | null;
  lastSeenAt: number;
}

export type SessionOp =
  | { op: 'touch'; id: number; lastSeenAt: number }
  | { op: 'close'; id: number; reason: SessionEndReason }
  | { op: 'open'; session: NewSession };

export interface PlanOptions {
  maxGapMs: number;
}

export function sameActivity(open: OpenSessionView, obs: Extract<Observation, { status: 'watching' }>): boolean {
  return open.deviceSerial === obs.deviceSerial && open.kind === obs.kind && open.appId === obs.appId;
}

export function planSessionOps(
  open: OpenSessionView | null,
  obs: Observation,
  now: number,
  opts: PlanOptions,
): SessionOp[] {
  const ops: SessionOp[] = [];
  let current = open;

  // Clock went backwards (NTP step, DST is irrelevant — we use UTC epoch): treat as a gap.
  const gap = current ? now - current.lastSeenAt : 0;
  if (current && (gap > opts.maxGapMs || gap < 0)) {
    ops.push({ op: 'close', id: current.id, reason: obs.status === 'unknown' ? obs.reason : 'gap' });
    current = null;
  }

  switch (obs.status) {
    case 'watching': {
      if (current && sameActivity(current, obs)) {
        ops.push({ op: 'touch', id: current.id, lastSeenAt: now });
      } else {
        if (current) ops.push({ op: 'close', id: current.id, reason: 'switch' });
        ops.push({
          op: 'open',
          session: {
            deviceSerial: obs.deviceSerial,
            kind: obs.kind,
            appId: obs.appId,
            appName: obs.appName,
            startedAt: now,
          },
        });
      }
      break;
    }
    case 'off':
      if (current) ops.push({ op: 'close', id: current.id, reason: 'power_off' });
      break;
    case 'unknown':
      // Tolerate transient failures: keep the session open (not extended). If the TV stays
      // unobservable past maxGapMs, the gap rule above closes it at its last confirmed poll.
      break;
  }
  return ops;
}

export interface SessionChange {
  closed: SessionRecord[];
  opened: SessionRecord | null;
}

export class SessionTracker {
  constructor(
    private readonly repos: Pick<Repos, 'sessions' | 'tx'>,
    private opts: PlanOptions,
  ) {}

  /** The gap tolerance depends on the poll interval, which can change at runtime. */
  setMaxGapMs(maxGapMs: number): void {
    this.opts = { ...this.opts, maxGapMs };
  }

  current(): SessionRecord | null {
    return this.repos.sessions.getOpen();
  }

  /** Apply one observation. Returns sessions closed/opened by it (for events & rules). */
  observe(obs: Observation, now: number): SessionChange {
    return this.repos.tx(() => {
      const open = this.repos.sessions.getOpen();
      const ops = planSessionOps(open, obs, now, this.opts);
      return this.apply(ops);
    });
  }

  /**
   * On startup: close a leftover open session if it is already stale. A fresh one (quick
   * restart) is left open so the first poll can continue it seamlessly.
   */
  recover(now: number): SessionRecord | null {
    return this.repos.tx(() => {
      const open = this.repos.sessions.getOpen();
      if (!open || now - open.lastSeenAt <= this.opts.maxGapMs) return null;
      this.repos.sessions.close(open.id, 'recovered');
      return this.repos.sessions.get(open.id);
    });
  }

  /** Close whatever is open (e.g. service uninstall). Normal restarts don't need this. */
  closeOpen(reason: SessionEndReason): SessionRecord | null {
    return this.repos.tx(() => {
      const open = this.repos.sessions.getOpen();
      if (!open) return null;
      this.repos.sessions.close(open.id, reason);
      return this.repos.sessions.get(open.id);
    });
  }

  private apply(ops: SessionOp[]): SessionChange {
    const change: SessionChange = { closed: [], opened: null };
    for (const op of ops) {
      switch (op.op) {
        case 'touch':
          this.repos.sessions.touch(op.id, op.lastSeenAt);
          break;
        case 'close': {
          this.repos.sessions.close(op.id, op.reason);
          const closed = this.repos.sessions.get(op.id);
          if (closed) change.closed.push(closed);
          break;
        }
        case 'open': {
          const id = this.repos.sessions.open(op.session);
          change.opened = this.repos.sessions.get(id);
          break;
        }
      }
    }
    return change;
  }
}
