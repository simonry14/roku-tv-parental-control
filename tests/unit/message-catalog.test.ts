import { describe, expect, it } from 'vitest';
import { TvMessagesConfigSchema, TvTextsSchema } from '../../src/config/schema.js';
import {
  CATALOG,
  CATALOG_BY_KEY,
  changedCount,
  compactTexts,
  fillTemplate,
  MESSAGE_KEYS,
  normalizeText,
  placeholdersIn,
  previewMessage,
  textFor,
  textProblems,
} from '../../src/enforce/message-catalog.js';

describe('message catalog', () => {
  it('lists every message once, and every default only uses its own fill-ins', () => {
    expect(CATALOG.map((e) => e.key)).toEqual([...MESSAGE_KEYS]);
    for (const entry of CATALOG) {
      for (const field of entry.fields) {
        expect(textProblems(entry, field, field.default), `${entry.key}.${field.id}`).toEqual([]);
        for (const p of placeholdersIn(field.default)) expect(entry.samples).toHaveProperty(p);
      }
    }
  });

  it('fills in the blanks and tidies what is left', () => {
    expect(fillTemplate('{app} isn’t allowed', { app: 'YouTube' })).toBe('YouTube isn’t allowed');
    // Empty value: the word goes, the punctuation closes up.
    expect(fillTemplate('A parent has locked the TV {until}.', { until: '' })).toBe('A parent has locked the TV.');
    // Unknown value: the whole line goes.
    expect(fillTemplate('TV time starts again {next}.\nSleep well!', { next: null })).toBe('Sleep well!');
    expect(fillTemplate('Off in {seconds}', { seconds: '^0 ^1' })).toBe('Off in ^0 ^1');
  });

  it('normalises what a parent types', () => {
    expect(normalizeText('  Two  spaces\r\n\r\n\n and ^ a caret\t ', true)).toBe('Two spaces\nand a caret');
    expect(normalizeText('One\nline', false)).toBe('One line');
  });

  it('explains problems in plain words', () => {
    const blocked = CATALOG_BY_KEY.app_blocked;
    const [title, body] = blocked.fields as [(typeof blocked.fields)[0], (typeof blocked.fields)[0]];
    expect(textProblems(blocked, title, '   ')).toEqual(['The headline can’t be empty.']);
    expect(textProblems(blocked, body, '')).toEqual([]);
    expect(textProblems(blocked, title, '{ap} is off')).toEqual(['{ap} can’t be filled in here. You can use {app}.']);
    expect(textProblems(blocked, title, 'x'.repeat(61))).toEqual(['Keep it to 60 characters (now 61).']);
    const parent = CATALOG_BY_KEY.parent;
    expect(textProblems(parent, parent.fields[0]!, 'From {app}')).toEqual([
      '{app} can’t be filled in here. This message has nothing to fill in.',
    ]);
  });

  it('keeps only real changes', () => {
    const texts = compactTexts({
      app_blocked: { title: '{app} isn’t allowed', body: ' Ask Mum.  ' },
      lock: { title: textFor(undefined, 'lock', 'title') },
    });
    expect(texts).toEqual({ app_blocked: { body: 'Ask Mum.' } });
    expect(changedCount(texts)).toBe(1);
    expect(textFor(texts, 'app_blocked', 'body')).toBe('Ask Mum.');
    expect(textFor(texts, 'app_blocked', 'title')).toBe('{app} isn’t allowed');
  });

  it('previews use the example values, and countdowns under a message that has one', () => {
    expect(previewMessage('app_blocked', undefined)).toMatchObject({ title: 'YouTube isn’t allowed', countdown: '' });
    expect(previewMessage('countdown_off', { countdown_off: { line: 'Bye in {seconds}' } })).toMatchObject({
      title: 'It’s quiet time',
      countdown: 'Bye in 30 seconds',
      countdownTemplate: 'Bye in ^0 ^1',
      countdownSec: 30,
    });
    expect(previewMessage('parent', { parent: { signature: 'Love, Dad' } })).toMatchObject({
      title: 'Dinner’s ready!',
      body: 'Love, Dad',
    });
  });
});

describe('tvMessages.texts in config.json and the dashboard', () => {
  it('validates keys, fields and fill-ins', () => {
    expect(TvTextsSchema.safeParse({ app_blocked: { title: 'Nope, {app}' } }).success).toBe(true);
    const bad = TvTextsSchema.safeParse({ app_blocked: { title: '{ap}', colour: 'red' } });
    expect(bad.success).toBe(false);
    const messages = bad.error!.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    expect(messages).toEqual([
      'app_blocked.title: {ap} can’t be filled in here. You can use {app}.',
      'app_blocked.colour: Unknown field "colour" (use title or body)',
    ]);
    expect(TvTextsSchema.safeParse({ nope: { title: 'x' } }).success).toBe(false);
  });

  it('loads the short-lived timesUpTip setting into the "Screen time’s up" message', () => {
    const tv = TvMessagesConfigSchema.parse({ timesUpTip: 'Tidy your room for more time.' });
    expect(tv.texts).toEqual({ global_budget: { body: 'You can watch again {next}.\nTidy your room for more time.' } });
    expect(TvMessagesConfigSchema.parse({ timesUpTip: '' }).texts).toEqual({
      global_budget: { body: 'You can watch again {next}.' },
    });
    // The default tip is the default message, so nothing is stored.
    expect(
      TvMessagesConfigSchema.parse({
        timesUpTip: 'To get more time on the TV, read a book, do a chore or practice Python programming.',
      }).texts,
    ).toEqual({});
    expect(TvMessagesConfigSchema.parse({}).texts).toEqual({});
  });
});
