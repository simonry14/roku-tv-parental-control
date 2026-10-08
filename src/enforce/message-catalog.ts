/**
 * Every message the Parental Control channel can show, with its default words and the fill-ins
 * ({app}, {until}, …) it accepts. The parent can rewrite any of them in the dashboard
 * (Settings → TV messages → Edit the messages) or in config.json under `tvMessages.texts`.
 *
 * Pure and dependency-free: the dashboard imports this file too (live preview, validation),
 * so no Node or Luxon imports here. tv-messages.ts fills the templates for real.
 */

export const PLACEHOLDERS = ['app', 'limit', 'next', 'until', 'time', 'minutes', 'seconds'] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

/** What each fill-in stands for, as the dashboard explains it. */
export const PLACEHOLDER_HELP: Record<Placeholder, string> = {
  app: 'the app’s name',
  limit: 'the daily limit',
  next: 'when TV time starts again',
  until: '“until” and a time, or nothing when there’s no end time',
  time: 'a time of day',
  minutes: 'the minutes left',
  seconds: 'the seconds left, counting down',
};

export type MessageGroup = 'apps' | 'schedule' | 'warnings' | 'other';

export const GROUPS: Array<{ id: MessageGroup; title: string; description: string }> = [
  { id: 'apps', title: 'When an app has to close', description: 'The message replaces the app, like pressing Home.' },
  {
    id: 'schedule',
    title: 'When it isn’t TV time',
    description: 'Shown with a countdown, then the TV switches off.',
  },
  {
    id: 'warnings',
    title: 'Warnings',
    description: 'Only when “Warn before time runs out” is on. The show comes back after a few seconds.',
  },
  { id: 'other', title: 'Countdowns and your messages', description: 'The small print on several screens.' },
];

export type MessageIcon = 'blocked' | 'budget' | 'schedule' | 'lock' | 'warning' | 'message' | 'info';

export interface MessageField {
  id: string;
  label: string;
  default: string;
  max: number;
  /** Must not be empty (the channel needs a headline / countdown line). */
  required: boolean;
  /** Line breaks allowed (the body). */
  multiline: boolean;
}

export interface MessageEntry {
  key: MessageKey;
  group: MessageGroup;
  name: string;
  /** When the TV shows it, for the parent. */
  when: string;
  icon: MessageIcon;
  placeholders: Placeholder[];
  /** Example values for previews. */
  samples: Partial<Record<Placeholder, string>>;
  fields: MessageField[];
}

const headline = (d: string): MessageField => ({
  id: 'title',
  label: 'Headline',
  default: d,
  max: 60,
  required: true,
  multiline: false,
});
const body = (d: string): MessageField => ({
  id: 'body',
  label: 'Message',
  default: d,
  max: 200,
  required: false,
  multiline: true,
});
const FINISH = 'Time to finish what you’re watching.';

export const MESSAGE_KEYS = [
  'app_blocked',
  'app_budget',
  'global_budget',
  'escalated',
  'quiet_hours',
  'not_yet',
  'over_for_today',
  'lock',
  'warn_global',
  'warn_app',
  'warn_schedule',
  'countdown_off',
  'countdown_back',
  'parent',
] as const;
export type MessageKey = (typeof MESSAGE_KEYS)[number];

export const CATALOG: MessageEntry[] = [
  {
    key: 'app_blocked',
    group: 'apps',
    name: 'Blocked app',
    when: 'Someone opens an app that isn’t allowed.',
    icon: 'blocked',
    placeholders: ['app'],
    samples: { app: 'YouTube' },
    fields: [headline('{app} isn’t allowed'), body('Pick something else to watch, or ask a parent.')],
  },
  {
    key: 'app_budget',
    group: 'apps',
    name: 'App limit reached',
    when: 'An app’s daily limit runs out. Other apps still work.',
    icon: 'budget',
    placeholders: ['app', 'limit'],
    samples: { app: 'YouTube', limit: '1 hour' },
    fields: [
      headline('No more {app} today'),
      body('You’ve used up today’s time for {app}. You can still watch something else.'),
    ],
  },
  {
    key: 'global_budget',
    group: 'apps',
    name: 'Screen time used up',
    when: 'Today’s screen time runs out.',
    icon: 'budget',
    placeholders: ['next', 'limit'],
    samples: { next: 'tomorrow from 3:30 PM', limit: '2 hours' },
    fields: [
      headline('Screen time’s up for today'),
      body(
        'You can watch again {next}.\nTo get more time on the TV, read a book, do a chore or practice Python programming.',
      ),
    ],
  },
  {
    key: 'escalated',
    group: 'apps',
    name: 'Kept trying',
    when: 'Someone keeps opening apps that aren’t allowed. The TV switches off after the countdown.',
    icon: 'blocked',
    placeholders: ['app'],
    samples: { app: 'YouTube' },
    fields: [headline('The TV is turning off'), body('You kept opening {app}, so the TV is switching off.')],
  },
  {
    key: 'quiet_hours',
    group: 'schedule',
    name: 'Quiet hours',
    when: 'The TV is switched on during quiet hours.',
    icon: 'schedule',
    placeholders: ['until'],
    samples: { until: 'until tomorrow at 7:00 AM' },
    fields: [headline('It’s quiet time'), body('The TV stays off {until}.')],
  },
  {
    key: 'not_yet',
    group: 'schedule',
    name: 'Before viewing hours',
    when: 'The TV is switched on before today’s viewing hours start.',
    icon: 'schedule',
    placeholders: ['time'],
    samples: { time: '3:30 PM' },
    fields: [headline('It’s not TV time yet'), body('TV time starts at {time}.')],
  },
  {
    key: 'over_for_today',
    group: 'schedule',
    name: 'After viewing hours',
    when: 'The TV is switched on after today’s viewing hours have ended.',
    icon: 'schedule',
    placeholders: ['next'],
    samples: { next: 'tomorrow at 3:30 PM' },
    fields: [headline('TV time is over for today'), body('TV time starts again {next}.')],
  },
  {
    key: 'lock',
    group: 'schedule',
    name: 'Locked',
    when: 'You lock the TV, or someone switches it on while it’s locked.',
    icon: 'lock',
    placeholders: ['until'],
    samples: { until: 'until 7:00 PM' },
    fields: [headline('The TV is locked'), body('A parent has locked the TV {until}.')],
  },
  {
    key: 'warn_global',
    group: 'warnings',
    name: 'Screen time almost used up',
    when: 'A few minutes before today’s screen time runs out.',
    icon: 'warning',
    placeholders: ['minutes'],
    samples: { minutes: '5 minutes' },
    fields: [headline('{minutes} left'), body(`Today’s screen time is nearly used up. ${FINISH}`)],
  },
  {
    key: 'warn_app',
    group: 'warnings',
    name: 'App time almost used up',
    when: 'A few minutes before an app’s daily limit runs out.',
    icon: 'warning',
    placeholders: ['minutes', 'app'],
    samples: { minutes: '5 minutes', app: 'YouTube' },
    fields: [headline('{minutes} of {app} left'), body(FINISH)],
  },
  {
    key: 'warn_schedule',
    group: 'warnings',
    name: 'Viewing hours about to end',
    when: 'A few minutes before viewing hours end or quiet hours start.',
    icon: 'warning',
    placeholders: ['minutes', 'time'],
    samples: { minutes: '5 minutes', time: '7:30 PM' },
    fields: [headline('{minutes} left'), body(`TV time ends at {time}. ${FINISH}`)],
  },
  {
    key: 'countdown_off',
    group: 'other',
    name: 'Countdown before switching off',
    when: 'Under every message that switches the TV off.',
    icon: 'schedule',
    placeholders: ['seconds'],
    samples: { seconds: '30 seconds' },
    fields: [
      {
        id: 'line',
        label: 'Countdown',
        default: 'The TV turns off in {seconds}',
        max: 60,
        required: true,
        multiline: false,
      },
      { id: 'end', label: 'At zero', default: 'Turning off now', max: 60, required: false, multiline: false },
    ],
  },
  {
    key: 'countdown_back',
    group: 'other',
    name: 'Going back to the show',
    when: 'Under a warning, or a message you send, before the show comes back.',
    icon: 'warning',
    placeholders: ['app', 'seconds'],
    samples: { app: 'YouTube', seconds: '8 seconds' },
    fields: [
      {
        id: 'line',
        label: 'Countdown',
        default: 'Back to {app} in {seconds}',
        max: 60,
        required: true,
        multiline: false,
      },
      { id: 'end', label: 'At zero', default: 'Going back to {app}', max: 60, required: false, multiline: false },
    ],
  },
  {
    key: 'parent',
    group: 'other',
    name: 'Your messages',
    when: 'When you send a message from the Now tab.',
    icon: 'message',
    placeholders: [],
    samples: {},
    fields: [
      {
        id: 'signature',
        label: 'Under a short message',
        default: 'From a parent',
        max: 40,
        required: false,
        multiline: false,
      },
      {
        id: 'longTitle',
        label: 'Headline above a long message',
        default: 'A message from a parent',
        max: 60,
        required: true,
        multiline: false,
      },
    ],
  },
];

export const CATALOG_BY_KEY = Object.fromEntries(CATALOG.map((e) => [e.key, e])) as Record<MessageKey, MessageEntry>;

/** Rewritten words, by message and field. Missing = the default. */
export type TvTexts = Partial<Record<MessageKey, Record<string, string>>>;

/** One field's words: the parent's version, or the default. */
export function textFor(texts: TvTexts | undefined, key: MessageKey, field: string): string {
  const custom = texts?.[key]?.[field];
  if (custom !== undefined) return custom;
  return CATALOG_BY_KEY[key].fields.find((f) => f.id === field)?.default ?? '';
}

/**
 * Tidy what a parent typed: no control characters (line breaks kept where allowed), single
 * spaces, one line break at most between lines, no carets (the channel uses ^0/^1 internally).
 */
export function normalizeText(text: string, multiline: boolean): string {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .replace(/\^/g, '')
    .split('\n')
    .map((l) =>
      l
        .replace(/\p{Cc}/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((l) => l !== '');
  return multiline ? lines.join('\n') : lines.join(' ');
}

const TOKEN = /\{([^{}\s]*)\}/g;

/** The fill-ins a text uses, in order (unknown names included, for validation). */
export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(TOKEN)].map((m) => m[1]!);
}

/** What's wrong with one field's words, as sentences for the parent. Empty = fine. */
export function textProblems(entry: MessageEntry, field: MessageField, raw: string): string[] {
  const text = normalizeText(raw, field.multiline);
  const problems: string[] = [];
  if (field.required && text === '') problems.push(`The ${field.label.toLowerCase()} can’t be empty.`);
  if (text.length > field.max) problems.push(`Keep it to ${field.max} characters (now ${text.length}).`);
  const unknown = [...new Set(placeholdersIn(text).filter((p) => !(entry.placeholders as string[]).includes(p)))];
  if (unknown.length) {
    const allowed = entry.placeholders.map((p) => `{${p}}`).join(', ');
    problems.push(
      `${unknown.map((u) => `{${u}}`).join(', ')} can’t be filled in here.` +
        (allowed ? ` You can use ${allowed}.` : ' This message has nothing to fill in.'),
    );
  }
  return problems;
}

/**
 * Fill in the blanks. An empty value ('') just disappears and the sentence is tidied, so
 * "locked the TV {until}." reads "locked the TV." A value that isn't known (null) drops the
 * whole line it's on, so "TV time starts again {next}." vanishes rather than dangling.
 */
export function fillTemplate(template: string, values: Partial<Record<Placeholder, string | null>>): string {
  return template
    .split('\n')
    .filter((l) => !placeholdersIn(l).some((p) => values[p as Placeholder] === null))
    .map((l) =>
      l
        .replace(TOKEN, (_m, name: string) => values[name as Placeholder] ?? '')
        .replace(/[ \t]+/g, ' ')
        .replace(/ ([.,!?;:])/g, '$1')
        .trim(),
    )
    .filter((l) => l !== '')
    .join('\n');
}

/**
 * Keep only real changes: normalised, known messages and fields, and different from the
 * default (so "reset" is simply leaving it out).
 */
export function compactTexts(texts: TvTexts | undefined): TvTexts {
  const out: TvTexts = {};
  for (const entry of CATALOG) {
    const given = texts?.[entry.key];
    if (!given) continue;
    const kept: Record<string, string> = {};
    for (const field of entry.fields) {
      const raw = given[field.id];
      if (raw === undefined) continue;
      const text = normalizeText(raw, field.multiline);
      if (text !== field.default) kept[field.id] = text;
    }
    if (Object.keys(kept).length) out[entry.key] = kept;
  }
  return out;
}

/** How many messages differ from the defaults. */
export function changedCount(texts: TvTexts | undefined): number {
  return Object.keys(compactTexts(texts)).length;
}

export interface PreviewMessage {
  icon: MessageIcon;
  title: string;
  body: string;
  /** The countdown line with the sample seconds, or '' when the message has none. */
  countdown: string;
  countdownSec: number;
  /** For the TV: the countdown with ^0 (number) and ^1 (second/seconds) for the channel to fill. */
  countdownTemplate: string;
  countdownEnd: string;
  /** In real use, OK closes it (countdowns before switching off can't be closed). */
  dismissable: boolean;
}

/** Messages shown with a countdown in real use, and which countdown. */
const COUNTDOWN_OF: Partial<Record<MessageKey, 'countdown_off' | 'countdown_back'>> = {
  escalated: 'countdown_off',
  quiet_hours: 'countdown_off',
  not_yet: 'countdown_off',
  over_for_today: 'countdown_off',
  lock: 'countdown_off',
  warn_global: 'countdown_back',
  warn_app: 'countdown_back',
  warn_schedule: 'countdown_back',
};

/** Fill a countdown line: {seconds} becomes the channel's ^0 ^1, or a sample for previews. */
export function countdownLine(
  texts: TvTexts | undefined,
  which: 'countdown_off' | 'countdown_back',
  values: Partial<Record<Placeholder, string | null>>,
  seconds: string | null = null,
): { line: string; end: string } {
  const v = { ...values, seconds: seconds ?? '^0 ^1' };
  return {
    line: fillTemplate(textFor(texts, which, 'line'), v),
    end: fillTemplate(textFor(texts, which, 'end'), v),
  };
}

/**
 * What a message looks like with the example values: for the dashboard preview and for
 * "Show on the TV". The countdown entries are previewed under a message that uses them.
 */
export function previewMessage(key: MessageKey, texts: TvTexts | undefined): PreviewMessage {
  const host: MessageKey = key === 'countdown_off' ? 'quiet_hours' : key === 'countdown_back' ? 'warn_app' : key;
  const entry = CATALOG_BY_KEY[host];
  const samples = { ...entry.samples, ...CATALOG_BY_KEY[key].samples };
  let title: string;
  let bodyText: string;
  if (key === 'parent') {
    title = 'Dinner’s ready!';
    bodyText = textFor(texts, 'parent', 'signature');
  } else {
    title = fillTemplate(textFor(texts, host, 'title'), samples);
    bodyText = fillTemplate(textFor(texts, host, 'body'), samples);
  }
  const which = COUNTDOWN_OF[host] ?? null;
  if (!which) {
    return {
      icon: entry.icon,
      title,
      body: bodyText,
      countdown: '',
      countdownSec: 0,
      countdownTemplate: '',
      countdownEnd: '',
      dismissable: true,
    };
  }
  const sec = which === 'countdown_off' ? 30 : 8;
  const shown = countdownLine(texts, which, samples, `${sec} seconds`);
  const tv = countdownLine(texts, which, samples);
  return {
    icon: entry.icon,
    title,
    body: bodyText,
    countdown: shown.line,
    countdownSec: sec,
    countdownTemplate: tv.line,
    countdownEnd: tv.end,
    dismissable: which === 'countdown_back',
  };
}
