/**
 * The canonical skill zip (KOBE-309, spec SK14): the only bytes Kobe ever hashes for a skill. Two
 * tools that hold the same files produce the same bytes, in every timezone, so the hash is an
 * identity. It is byte-for-byte what the server's canonical repack has written since KOBE-78
 * (fflate `zipSync`, stored), so every existing `content_hash` is a runtime hash under this rule.
 *
 * Layout (all integers little-endian), for each file in {@link canonicalOrder}:
 *
 *  local file header   `50 4b 03 04`, version needed 20, flags, method 0 (stored), time 0x6000,
 *                      date 0x5021, CRC-32, compressed size = size, size, name length, extra 0;
 *                      then the UTF-8 name and the file's bytes.
 *
 * then for each file, in the same order, a central directory header `50 4b 01 02`: version made
 * by 20 (MS-DOS), version needed 20, flags, method 0, time, date, CRC-32, sizes, name length,
 * extra 0, comment 0, disk 0, internal attributes 0, external attributes 0, local header offset,
 * the name; then the end record `50 4b 05 06`: disk 0, directory disk 0, entry count twice,
 * directory size, directory offset, comment 0.
 *
 * - flags: 0x0800 (UTF-8 names) when the name has a non-ASCII character, else 0.
 * - time/date: the DOS encoding of 2020-01-01 12:00:00, fixed.
 * - No directory entries, extra fields, comments, data descriptors, encryption or zip64; every
 *   size must fit 32 bits (skills are far below).
 *
 * Pure and dependency-free (no hashing here: `@kobe/protocol/node` hashes these bytes).
 */

const DOS_TIME = 0x6000; // 12:00:00
const DOS_DATE = 0x5021; // 2020-01-01
const VERSION = 20;
const UTF8_FLAG = 0x0800;
const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;

/** A name that JavaScript treats as an array index: such object keys enumerate first. */
const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/;
const MAX_ARRAY_INDEX = 2 ** 32 - 2;
const isArrayIndex = (name: string): boolean =>
  ARRAY_INDEX.test(name) && Number(name) <= MAX_ARRAY_INDEX;

/**
 * The order of entries: names compared as UTF-16 code units (JavaScript's default sort), except
 * that names which are array indices ("7", "10": only possible at the root, without a slash) come
 * first in numeric order. The exception is what the KOBE-78 repack produced (fflate takes an
 * object, and objects enumerate index keys first), kept so that existing hashes stay valid.
 */
export function canonicalOrder(names: Iterable<string>): string[] {
  const all = [...names];
  const indices = all.filter(isArrayIndex).sort((a, b) => Number(a) - Number(b));
  const rest = all.filter((n) => !isArrayIndex(n)).sort();
  return [...indices, ...rest];
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3, as zip uses). */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();
// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\u0000-\u007f]/;

interface Entry {
  readonly name: Uint8Array;
  readonly flags: number;
  readonly data: Uint8Array;
  readonly crc: number;
  readonly offset: number;
}

/**
 * The canonical zip of `files` (path → bytes). Paths are used as given: check them first with
 * `checkPackagePaths` (skill-package/layout.ts), which also refuses names that differ only by
 * case or normalization.
 */
export function canonicalZip(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const entries: Entry[] = [];
  let offset = 0;
  for (const path of canonicalOrder(files.keys())) {
    const data = files.get(path) as Uint8Array;
    const name = encoder.encode(path);
    const entry = {
      name,
      flags: NON_ASCII.test(path) ? UTF8_FLAG : 0,
      data,
      crc: crc32(data),
      offset,
    };
    entries.push(entry);
    offset += LOCAL_HEADER + name.length + data.length;
  }
  const directorySize = entries.reduce((n, e) => n + CENTRAL_HEADER + e.name.length, 0);
  if (entries.length > 0xffff || offset + directorySize + END_RECORD > 0xffffffff)
    throw new RangeError("skill too large for a canonical zip (no zip64)");
  const out = new Uint8Array(offset + directorySize + END_RECORD);
  const view = new DataView(out.buffer);
  let at = 0;
  const u16 = (v: number) => {
    view.setUint16(at, v, true);
    at += 2;
  };
  const u32 = (v: number) => {
    view.setUint32(at, v >>> 0, true);
    at += 4;
  };
  const bytes = (b: Uint8Array) => {
    out.set(b, at);
    at += b.length;
  };
  const common = (e: Entry) => {
    u16(VERSION);
    u16(e.flags);
    u16(0); // stored
    u16(DOS_TIME);
    u16(DOS_DATE);
    u32(e.crc);
    u32(e.data.length);
    u32(e.data.length);
    u16(e.name.length);
    u16(0); // extra
  };
  for (const e of entries) {
    u32(0x04034b50);
    common(e);
    bytes(e.name);
    bytes(e.data);
  }
  for (const e of entries) {
    u32(0x02014b50);
    u16(VERSION); // made by: MS-DOS, 2.0
    common(e);
    u16(0); // comment
    u16(0); // disk
    u16(0); // internal attributes
    u32(0); // external attributes
    u32(e.offset);
    bytes(e.name);
  }
  u32(0x06054b50);
  u16(0);
  u16(0);
  u16(entries.length);
  u16(entries.length);
  u32(directorySize);
  u32(offset);
  u16(0);
  return out;
}
