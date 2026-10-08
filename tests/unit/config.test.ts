import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../../src/config/load.js';

const where = { configPath: path.resolve('/srv/rg/config.json'), baseDir: path.resolve('/srv/rg') };

describe('config', () => {
  it('an empty object yields full defaults (nested defaults applied)', () => {
    const c = parseConfig({}, where);
    expect(c.timezone).toBe('America/New_York');
    expect(c.device.port).toBe(8060);
    expect(c.monitor.pollIntervalSec).toBe(5);
    expect(c.monitor.maxGapSec).toBe(15);
    expect(c.discovery.ssdpTimeoutMs).toBe(3000);
    expect(c.usage.excludeAppIds).toEqual(['dev']);
  });

  it('derives maxGap from the poll interval', () => {
    expect(parseConfig({ monitor: { pollIntervalSec: 10 } }, where).monitor.maxGapSec).toBe(30);
    expect(parseConfig({ monitor: { pollIntervalSec: 10, maxGapSec: 12 } }, where).monitor.maxGapSec).toBe(12);
  });

  it('treats empty strings (as in config.example.json) as unset', () => {
    const c = parseConfig({ device: { serial: '', host: '  ' } }, where);
    expect(c.device.serial).toBeUndefined();
    expect(c.device.host).toBeUndefined();
  });

  it('resolves relative paths against the config directory, not cwd', () => {
    const c = parseConfig({ database: { path: 'data/x.db' }, log: { file: 'logs/x.log' } }, where);
    expect(c.database.path).toBe(path.resolve('/srv/rg/data/x.db'));
    expect(c.log.file).toBe(path.resolve('/srv/rg/logs/x.log'));
    expect(parseConfig({ log: { file: null } }, where).log.file).toBeNull();
    expect(parseConfig({ database: { path: ':memory:' } }, where).database.path).toBe(':memory:');
  });

  it('rejects invalid time zones, out-of-range values and unknown keys', () => {
    expect(() => parseConfig({ timezone: 'Mars/Olympus' }, where)).toThrow(ConfigError);
    expect(() => parseConfig({ monitor: { pollIntervalSec: 0 } }, where)).toThrow(ConfigError);
    expect(() => parseConfig({ devcie: {} }, where)).toThrow(/devcie/);
  });
});
