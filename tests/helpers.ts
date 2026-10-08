import { parseConfig } from '../src/config/load.js';
import type { Config, ConfigInput } from '../src/config/schema.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { createRepos, type Repos } from '../src/db/repo.js';
import type { Clock } from '../src/lib/time.js';
import { startMockRoku, type MockRoku, type MockRokuOptions } from '../mock/mock-roku.js';

export function testConfig(input: ConfigInput = {}): Config {
  return parseConfig(
    { database: { path: ':memory:' }, log: { level: 'silent', file: null }, backup: { enabled: false }, ...input },
    {
      configPath: '/virtual/config.json',
      baseDir: '/virtual',
    },
  );
}

export function memoryDb(): { db: Db; repos: Repos } {
  const db = openDatabase(':memory:');
  return { db, repos: createRepos(db) };
}

export interface FakeClock extends Clock {
  set(ms: number): void;
  advance(ms: number): number;
}

export function fakeClock(start = Date.UTC(2026, 8, 30, 19, 0, 0)): FakeClock {
  let t = start;
  return {
    now: () => t,
    set: (ms) => {
      t = ms;
    },
    advance: (ms) => (t += ms),
  };
}

/** Mock Roku on random ports, bound to loopback, quiet, SSDP off unless asked for. */
export function mockRoku(opts: MockRokuOptions = {}): Promise<MockRoku> {
  return startMockRoku({ host: '127.0.0.1', ecpPort: 0, controlPort: null, ssdp: false, quiet: true, ...opts });
}

export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
