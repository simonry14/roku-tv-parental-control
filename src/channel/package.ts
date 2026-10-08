import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../lib/paths.js';
import { createZip, type ZipEntry } from './zip.js';

/** The "Time's up" channel source (BrightScript/SceneGraph), relative to the project root. */
export const CHANNEL_DIR = 'roku-channel';

/** What goes into the package. art/ (SVG sources), out/ and the brighterscript config stay out. */
const INCLUDE = ['manifest', 'source', 'components', 'images', 'fonts'];

function walk(dir: string, rel: string, out: ZipEntry[]): void {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const abs = path.join(dir, name);
    const relName = rel ? `${rel}/${name}` : name;
    if (statSync(abs).isDirectory()) walk(abs, relName, out);
    else out.push({ name: relName, data: readFileSync(abs) });
  }
}

export function channelEntries(root = path.join(projectRoot(), CHANNEL_DIR)): ZipEntry[] {
  const entries: ZipEntry[] = [];
  for (const item of INCLUDE) {
    const abs = path.join(root, item);
    if (statSync(abs, { throwIfNoEntry: false })?.isDirectory()) walk(abs, item, entries);
    else entries.push({ name: item, data: readFileSync(abs) });
  }
  if (!entries.some((e) => e.name === 'manifest')) throw new Error(`No manifest in ${root}`);
  return entries;
}

/** The sideloadable channel package (a zip with `manifest` at its root). */
export function buildChannelPackage(root?: string): Buffer {
  return createZip(channelEntries(root));
}

/** Channel version from the manifest, e.g. "1.0.1". */
export function channelVersion(root = path.join(projectRoot(), CHANNEL_DIR)): string {
  const manifest = readFileSync(path.join(root, 'manifest'), 'utf8');
  const get = (k: string): string => new RegExp(`^${k}=(\\d+)`, 'm').exec(manifest)?.[1] ?? '0';
  return `${get('major_version')}.${get('minor_version')}.${get('build_version')}`;
}
