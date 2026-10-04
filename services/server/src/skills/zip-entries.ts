/**
 * A minimal, strict ZIP central-directory reader (KOBE-78). It reads only what skill validation
 * must trust before any byte is inflated: names, declared sizes, methods, flags and the symlink
 * bit. Anything it can't vouch for (zip64, encryption, multi-disk, odd methods, truncated
 * records) is rejected, never guessed at.
 */
const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const UNIX = 3;

export interface ZipEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isSymlink: boolean;
  readonly method: 0 | 8;
  readonly compressedSize: number;
  readonly size: number;
  /** Offset of the entry's data in the archive. */
  readonly dataOffset: number;
}

export class ZipFormatError extends Error {
  constructor(readonly reason: "bad_zip" | "too_many_files" | "unsupported_zip" | "symlink") {
    super(reason);
    this.name = "ZipFormatError";
  }
}

const bad = (): never => {
  throw new ZipFormatError("bad_zip");
};

/** Lists the entries of `zip`, refusing more than `maxEntries` before parsing them. */
export function readZipEntries(zip: Uint8Array, maxEntries: number): ZipEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = findEocd(zip, view);
  const disk = view.getUint16(eocd + 4, true);
  const cdDisk = view.getUint16(eocd + 6, true);
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (
    disk !== 0 ||
    cdDisk !== 0 ||
    count === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  )
    throw new ZipFormatError("unsupported_zip");
  if (count > maxEntries) throw new ZipFormatError("too_many_files");
  if (cdOffset + cdSize > eocd) bad();

  const entries: ZipEntry[] = [];
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > eocd || view.getUint32(at, true) !== CENTRAL_SIG) bad();
    const madeBy = view.getUint16(at + 4, true);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const externalAttrs = view.getUint32(at + 38, true);
    const localOffset = view.getUint32(at + 42, true);
    const next = at + 46 + nameLen + extraLen + commentLen;
    if (next > eocd) bad();
    if ((flags & 0x1) !== 0 || (flags & 0x40) !== 0 || (method !== 0 && method !== 8))
      throw new ZipFormatError("unsupported_zip");
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff)
      throw new ZipFormatError("unsupported_zip");
    if (method === 0 && compressedSize !== size) bad();
    const name = decodeName(zip.subarray(at + 46, at + 46 + nameLen));
    const isSymlink = madeBy >> 8 === UNIX && ((externalAttrs >>> 16) & S_IFMT) === S_IFLNK;
    if (isSymlink) throw new ZipFormatError("symlink");
    entries.push({
      name,
      isDirectory: name.endsWith("/"),
      isSymlink,
      method,
      compressedSize,
      size,
      dataOffset: dataOffsetOf(zip, view, localOffset, compressedSize),
    });
    at = next;
  }
  return entries;
}

function findEocd(zip: Uint8Array, view: DataView): number {
  const lowest = Math.max(0, zip.length - EOCD_MIN - MAX_COMMENT);
  for (let at = zip.length - EOCD_MIN; at >= lowest; at--) {
    if (view.getUint32(at, true) === EOCD_SIG) {
      const commentLen = view.getUint16(at + 20, true);
      if (at + EOCD_MIN + commentLen === zip.length) return at;
    }
  }
  return bad();
}

function dataOffsetOf(
  zip: Uint8Array,
  view: DataView,
  localOffset: number,
  compressedSize: number,
): number {
  if (localOffset + 30 > zip.length || view.getUint32(localOffset, true) !== LOCAL_SIG) bad();
  const start =
    localOffset +
    30 +
    view.getUint16(localOffset + 26, true) +
    view.getUint16(localOffset + 28, true);
  if (start + compressedSize > zip.length) bad();
  return start;
}

function decodeName(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return bad();
  }
}
