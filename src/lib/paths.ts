import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Our package.json's name (and the project's name before v1.0, for an older checkout). */
const PACKAGE_NAMES = new Set(['roku-tv-parental-control', 'roku-guardian']);
let cachedRoot: string | undefined;

/**
 * Locate the project root by walking up from this module until we find our package.json.
 * Works from `src/` (tsx), `dist/src/` (built) and when started as a Windows service, whose
 * working directory is C:\Windows\System32 — so never rely on process.cwd() for paths.
 */
export function projectRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkgPath = path.join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
        if (pkg.name && PACKAGE_NAMES.has(pkg.name)) return (cachedRoot = dir);
      } catch {
        // unreadable package.json — keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return (cachedRoot = process.cwd());
}

/** Resolve `p` against `baseDir` unless it is already absolute (or the SQLite in-memory marker). */
export function resolvePath(baseDir: string, p: string): string {
  if (p === ':memory:' || path.isAbsolute(p)) return p;
  return path.resolve(baseDir, p);
}
