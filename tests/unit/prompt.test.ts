import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { clock12, parseClockInput, parseHoursInput } from '../../src/cli/prompt.js';
import { saveEnv } from '../../src/cli/setup.js';

describe('setup wizard input', () => {
  it('understands times the way people type them', () => {
    expect(parseClockInput('8:30 PM')).toBe('20:30');
    expect(parseClockInput('8:30pm')).toBe('20:30');
    expect(parseClockInput('8pm')).toBe('20:00');
    expect(parseClockInput('830pm')).toBe('20:30');
    expect(parseClockInput('20:30')).toBe('20:30');
    expect(parseClockInput('7')).toBe('07:00');
    expect(parseClockInput('12am')).toBe('00:00');
    expect(parseClockInput('12:15 p.m.')).toBe('12:15');
    expect(parseClockInput('25:00')).toBeNull();
    expect(parseClockInput('13pm')).toBeNull();
    expect(parseClockInput('soon')).toBeNull();
    expect(clock12('20:30')).toBe('8:30 PM');
    expect(clock12('00:05')).toBe('12:05 AM');
  });

  it('understands hours of TV', () => {
    expect(parseHoursInput('2')).toBe(120);
    expect(parseHoursInput('1.5')).toBe(90);
    expect(parseHoursInput('1:30')).toBe(90);
    expect(parseHoursInput('2 hours')).toBe(120);
    expect(parseHoursInput('45 min')).toBe(45);
    expect(parseHoursInput('0')).toBeNull();
    expect(parseHoursInput('none')).toBeNull();
    expect(parseHoursInput('lots')).toBeUndefined();
  });

  it('saves one line of .env and keeps the others', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'env-'));
    try {
      const file = path.join(dir, '.env');
      saveEnv('ROKU_DEV_PASSWORD', 'one', file);
      expect(readFileSync(file, 'utf8')).toBe('ROKU_DEV_PASSWORD=one\n');
      writeFileSync(file, 'NTFY_TOKEN=abc\r\nROKU_DEV_PASSWORD=one\r\n\r\n');
      saveEnv('ROKU_DEV_PASSWORD', 'two', file);
      expect(readFileSync(file, 'utf8')).toBe('NTFY_TOKEN=abc\nROKU_DEV_PASSWORD=two\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
