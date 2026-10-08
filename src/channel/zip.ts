import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * Minimal ZIP writer (PKZIP 2.0: stored or deflated entries, no ZIP64), enough for a Roku channel
 * package. Output is deterministic (fixed timestamps), so the same channel source always produces
 * the same bytes and the TV's "identical to previous version" check works.
 */

export interface ZipEntry {
  /** Path inside the archive, with forward slashes. */
  name: string;
  data: Buffer;
}

const FIXED_DOS_TIME = 0; // 00:00:00
const FIXED_DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01
const UTF8_NAMES = 0x0800;

export function createZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    if (e.name.startsWith('/') || e.name.includes('\\')) throw new Error(`Bad zip entry name: ${e.name}`);
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data) >>> 0;
    const deflated = deflateRawSync(e.data, { level: 9 });
    const useDeflate = deflated.length < e.data.length;
    const body = useDeflate ? deflated : e.data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(FIXED_DOS_TIME, 10);
    local.writeUInt16LE(FIXED_DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(FIXED_DOS_TIME, 12);
    central.writeUInt16LE(FIXED_DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // extra, comment, disk, internal attrs, external attrs: all zero
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Names in a ZIP's central directory (used by the mock TV and tests to check a package). */
export function listZipEntries(zip: Buffer): string[] {
  const endAt = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error('Not a zip file');
  const count = zip.readUInt16LE(endAt + 10);
  let p = zip.readUInt32LE(endAt + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip central directory');
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    names.push(zip.toString('utf8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/** One entry's contents (stored or deflated), or null. Walks the local headers; enough for our own zips. */
export function readZipEntry(zip: Buffer, name: string): Buffer | null {
  let p = 0;
  while (p + 30 <= zip.length && zip.readUInt32LE(p) === 0x04034b50) {
    const method = zip.readUInt16LE(p + 8);
    const size = zip.readUInt32LE(p + 18);
    const nameLen = zip.readUInt16LE(p + 26);
    const extraLen = zip.readUInt16LE(p + 28);
    const start = p + 30 + nameLen + extraLen;
    if (zip.toString('utf8', p + 30, p + 30 + nameLen) === name) {
      const data = zip.subarray(start, start + size);
      return method === 8 ? inflateRawSync(data) : Buffer.from(data);
    }
    p = start + size;
  }
  return null;
}
