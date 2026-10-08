import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { projectRoot, resolvePath } from '../lib/paths.js';
import { ConfigSchema, type Config, type ParsedConfig } from './schema.js';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export interface LoadConfigOptions {
  /** Explicit config path (e.g. from --config). Must exist if given. */
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** Load `.env` from the project root (secrets live there, never in config.json). */
export function loadDotEnv(root = projectRoot()): void {
  const envPath = path.join(root, '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

/**
 * Load, validate and resolve configuration.
 *   1. `.env` from the project root is loaded into process.env (does not override existing vars)
 *   2. config file: --config, else $ROKU_GUARDIAN_CONFIG, else <root>/config.json (optional)
 *   3. env overrides: LOG_LEVEL
 */
export function loadConfig(opts: LoadConfigOptions = {}): Config {
  const root = projectRoot();
  loadDotEnv(root);
  const env = opts.env ?? process.env;

  const explicit = opts.configPath ?? env.ROKU_GUARDIAN_CONFIG;
  const configPath = path.resolve(root, explicit ?? 'config.json');

  let raw: unknown = {};
  if (existsSync(configPath)) {
    const text = readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''); // Notepad writes a BOM
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new ConfigError(`Config file ${configPath} is not valid JSON: ${(err as Error).message}`);
    }
  } else if (explicit) {
    throw new ConfigError(`Config file not found: ${configPath}`);
  }

  const config = parseConfig(raw, { configPath, baseDir: path.dirname(configPath) });

  const envLevel = env.LOG_LEVEL?.toLowerCase();
  if (envLevel && (LOG_LEVELS as readonly string[]).includes(envLevel)) {
    config.log.level = envLevel as (typeof LOG_LEVELS)[number];
  }
  return config;
}

/** Validate a raw config object and fill in derived values. Pure — used directly by tests. */
export function parseConfig(raw: unknown, where: { configPath: string; baseDir: string }): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`Invalid config (${where.configPath}):\n${z.prettifyError(result.error)}`);
  }
  return resolveConfig(result.data, where);
}

function resolveConfig(parsed: ParsedConfig, where: { configPath: string; baseDir: string }): Config {
  const { baseDir } = where;
  return {
    ...parsed,
    monitor: {
      ...parsed.monitor,
      maxGapSec: parsed.monitor.maxGapSec ?? Math.max(15, parsed.monitor.pollIntervalSec * 3),
    },
    database: { ...parsed.database, path: resolvePath(baseDir, parsed.database.path) },
    log: { ...parsed.log, file: parsed.log.file === null ? null : resolvePath(baseDir, parsed.log.file) },
    backup: { ...parsed.backup, dir: resolvePath(baseDir, parsed.backup.dir) },
    configPath: where.configPath,
    baseDir,
  };
}
