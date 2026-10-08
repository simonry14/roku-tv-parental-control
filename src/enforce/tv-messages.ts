import { DateTime } from 'luxon';
import { globalBudgetFor } from '../rules/engine.js';
import { nextAllowedAt } from '../rules/schedule.js';
import type { Decision, Override, Rules } from '../rules/types.js';
import {
  countdownLine,
  fillTemplate,
  previewMessage,
  textFor,
  type MessageKey,
  type Placeholder,
  type TvTexts,
} from './message-catalog.js';

/**
 * What the "Time's up" channel shows. Pure: the channel only lays it out (roku-channel/source/main.brs
 * documents the launch parameters). The words are templates from message-catalog.ts, rewritten by the
 * parent in the dashboard (tvMessages.texts); this file works out the values to fill in.
 */

export type TvMessageKind = 'blocked' | 'budget' | 'schedule' | 'lock' | 'warning' | 'message' | 'info';

export interface TvMessage {
  kind: TvMessageKind;
  title: string;
  body: string;
  /** Seconds of countdown on screen; 0 = none. */
  countdownSec: number;
  /** ^0 = seconds left, ^1 = "second"/"seconds". */
  countdownText: string;
  /** Shown when the countdown reaches zero. */
  countdownEnd: string;
  /** OK/Back close the channel (to Home). Countdown screens stay up. */
  dismissable: boolean;
}

export const MAX_PARENT_MESSAGE = 140;

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

/** Launch/input parameters for the channel (protocol v1). */
export function toChannelParams(m: TvMessage): Record<string, string> {
  const p: Record<string, string> = { v: '1', kind: m.kind, t: b64url(m.title) };
  if (m.body) p.b = b64url(m.body);
  if (m.countdownSec > 0) {
    p.cd = String(m.countdownSec);
    p.ct = b64url(m.countdownText);
    if (m.countdownEnd) p.ce = b64url(m.countdownEnd);
  }
  p.ok = m.dismissable ? '1' : '0';
  return p;
}

const message = (m: Partial<TvMessage> & Pick<TvMessage, 'kind' | 'title'>): TvMessage => ({
  body: '',
  countdownSec: 0,
  countdownText: '',
  countdownEnd: '',
  dismissable: true,
  ...m,
});

/** Title and body of a catalog message with the values filled in. */
function words(
  texts: TvTexts | undefined,
  key: MessageKey,
  values: Partial<Record<Placeholder, string | null>>,
): { title: string; body: string } {
  return {
    title: fillTemplate(textFor(texts, key, 'title'), values),
    body: fillTemplate(textFor(texts, key, 'body'), values),
  };
}

/** "7:00 PM", "tomorrow at 7:00 AM", "Saturday at 8:00 AM". */
export function whenText(at: number, now: number, zone: string): string {
  const t = DateTime.fromMillis(at, { zone });
  const today = DateTime.fromMillis(now, { zone }).startOf('day');
  const days = Math.round(t.startOf('day').diff(today, 'days').days);
  const time = t.toFormat('h:mm a');
  if (days <= 0) return time;
  if (days === 1) return `tomorrow at ${time}`;
  return `${t.toFormat('cccc')} at ${time}`;
}

/** When viewing is possible again after today's screen time ran out: "tomorrow from 3:30 PM". */
export function nextDayText(rules: Rules, now: number, zone: string): string {
  const today = DateTime.fromMillis(now, { zone }).startOf('day');
  const tomorrow = today.plus({ days: 1 }).toMillis();
  const next = nextAllowedAt(rules, tomorrow, zone);
  if (next === null) return 'tomorrow';
  const t = DateTime.fromMillis(next, { zone });
  const days = Math.round(t.startOf('day').diff(today, 'days').days);
  const day = days <= 1 ? 'tomorrow' : t.toFormat('cccc');
  return next > tomorrow ? `${day} from ${t.toFormat('h:mm a')}` : day;
}

/** "45 minutes", "1 hour", "1 hour and 30 minutes". */
export function minutesText(min: number): string {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const r = m % 60;
  const hours = h === 1 ? '1 hour' : `${h} hours`;
  const mins = r === 1 ? '1 minute' : `${r} minutes`;
  if (h === 0) return mins;
  return r === 0 ? hours : `${hours} and ${mins}`;
}

function turnsOff(
  sec: number,
  texts: TvTexts | undefined,
): Pick<TvMessage, 'countdownSec' | 'countdownText' | 'countdownEnd' | 'dismissable'> {
  const { line, end } = countdownLine(texts, 'countdown_off', {});
  return { countdownSec: sec, countdownText: line, countdownEnd: end, dismissable: false };
}

function goesBack(
  sec: number,
  appName: string | null,
  texts: TvTexts | undefined,
): Pick<TvMessage, 'countdownSec' | 'countdownText' | 'countdownEnd'> {
  const { line, end } = countdownLine(texts, 'countdown_back', { app: appName ?? 'your show' });
  return { countdownSec: sec, countdownText: line, countdownEnd: end };
}

export interface EnforcementMessageInput {
  decision: Decision;
  rules: Rules;
  override: Override | null;
  /** Repeated app-rule violations escalated a Home into a PowerOff. */
  escalated: boolean;
  /** Countdown before PowerOff (power-off decisions only). */
  countdownSec: number;
  /** The parent's rewritten messages (tvMessages.texts); missing ones use the defaults. */
  texts?: TvTexts;
  now: number;
  zone: string;
}

/** The limit that ran out, in words ("2 hours"), or null when there is none. */
function limitText(rules: Rules, d: Decision, now: number, zone: string): string | null {
  const m =
    d.reason === 'app_budget' && d.appId
      ? rules.appBudgets[d.appId]
      : globalBudgetFor(rules, DateTime.fromMillis(now, { zone }));
  return m === undefined || m === null ? null : minutesText(m);
}

/** The message for an enforcement decision (action home or power_off). */
export function enforcementMessage(i: EnforcementMessageInput): TvMessage {
  const { decision: d, rules, now, zone, texts } = i;
  const app = d.appName ?? 'This app';

  if (i.escalated) {
    return message({ kind: 'blocked', ...words(texts, 'escalated', { app }), ...turnsOff(i.countdownSec, texts) });
  }

  switch (d.reason) {
    case 'lock': {
      const until = i.override?.until ?? null;
      return message({
        kind: 'lock',
        ...words(texts, 'lock', { until: until ? `until ${whenText(until, now, zone)}` : '' }),
        ...turnsOff(i.countdownSec, texts),
      });
    }
    case 'quiet_hours': {
      const next = nextAllowedAt(rules, now, zone);
      return message({
        kind: 'schedule',
        ...words(texts, 'quiet_hours', { until: next ? `until ${whenText(next, now, zone)}` : '' }),
        ...turnsOff(i.countdownSec, texts),
      });
    }
    case 'outside_window': {
      const next = nextAllowedAt(rules, now, zone);
      const sameDay =
        next !== null && DateTime.fromMillis(next, { zone }).hasSame(DateTime.fromMillis(now, { zone }), 'day');
      return message({
        kind: 'schedule',
        ...(sameDay
          ? words(texts, 'not_yet', { time: whenText(next, now, zone) })
          : words(texts, 'over_for_today', { next: next ? whenText(next, now, zone) : null })),
        ...turnsOff(i.countdownSec, texts),
      });
    }
    case 'app_blocked':
      return message({ kind: 'blocked', ...words(texts, 'app_blocked', { app }) });
    case 'app_budget':
      return message({ kind: 'budget', ...words(texts, 'app_budget', { app, limit: limitText(rules, d, now, zone) }) });
    case 'global_budget':
      return message({
        kind: 'budget',
        ...words(texts, 'global_budget', {
          next: nextDayText(rules, now, zone),
          limit: limitText(rules, d, now, zone),
        }),
      });
    default:
      return message({ kind: 'info', title: 'Time for a break', body: d.message });
  }
}

export interface WarningInput {
  minutesLeft: number;
  /** What runs out: today's screen time, this app's time, or the viewing hours. */
  scope: 'global' | 'app' | 'schedule';
  endsAt: number;
  appName: string | null;
  /** Seconds before the show comes back. */
  returnSec: number;
  texts?: TvTexts;
  now: number;
  zone: string;
}

export function warningMessage(w: WarningInput): TvMessage {
  const app = w.appName ?? 'your show';
  const values = {
    minutes: w.minutesLeft === 1 ? '1 minute' : `${w.minutesLeft} minutes`,
    app,
    time: whenText(w.endsAt, w.now, w.zone),
  };
  const key: MessageKey = w.scope === 'app' ? 'warn_app' : w.scope === 'schedule' ? 'warn_schedule' : 'warn_global';
  return message({
    kind: 'warning',
    ...words(w.texts, key, values),
    ...goesBack(w.returnSec, app, w.texts),
    dismissable: true,
  });
}

/** One line of plain text: control characters and runs of whitespace collapse to a space; capped length. */
export function cleanMessageText(text: string): string {
  return text
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PARENT_MESSAGE);
}

/** Short messages are the headline; longer ones go in the body, under a generic headline. */
const PARENT_TITLE_MAX = 56;

export function parentMessage(
  text: string,
  opts: { returnSec: number; appName: string | null; texts?: TvTexts },
): TvMessage {
  const clean = cleanMessageText(text);
  const short = clean.length <= PARENT_TITLE_MAX;
  return message({
    kind: 'message',
    title: short ? clean : textFor(opts.texts, 'parent', 'longTitle'),
    body: short ? textFor(opts.texts, 'parent', 'signature') : clean,
    ...(opts.returnSec > 0 ? goesBack(opts.returnSec, opts.appName, opts.texts) : {}),
    dismissable: true,
  });
}

export function testMessage(): TvMessage {
  return message({
    kind: 'info',
    title: 'This is a test message',
    body: 'Messages from Parental Control look like this. Press OK to close it.',
  });
}

/** "Show on the TV" from the message editor: the example values, closable with OK, nothing else happens. */
export function previewTvMessage(key: MessageKey, texts: TvTexts | undefined): TvMessage {
  const p = previewMessage(key, texts);
  return message({
    kind: p.icon,
    title: p.title,
    body: p.body,
    countdownSec: p.countdownSec,
    countdownText: p.countdownTemplate,
    countdownEnd: p.countdownEnd,
    dismissable: true,
  });
}
