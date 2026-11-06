import { inflateRawSync } from "node:zlib";

/** One file of a zip, read lazily from its central-directory record. */
interface ZipEntry {
  readonly method: number;
  readonly compressedSize: number;
  readonly localHeader: number;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_MIN = 22;
const COMMENT_MAX = 0xffff;
const STORED = 0;
const DEFLATED = 8;

/**
 * A minimal zip reader for the export check (KOBE-549): the central directory gives each file's
 * size and offset (the export is streamed by fflate with data descriptors, so the local headers
 * carry no sizes), and a file is inflated only when asked for. No zip64: fflate never writes it.
 */
export class ZipFile {
  private readonly entries = new Map<string, ZipEntry>();
  private readonly buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
    const eocd = this.findEnd();
    const count = buf.readUInt16LE(eocd + 10);
    let at = buf.readUInt32LE(eocd + 16);
    for (let i = 0; i < count; i += 1) {
      if (buf.readUInt32LE(at) !== CENTRAL_SIG) throw new Error(`bad central record at ${at}`);
      const nameLen = buf.readUInt16LE(at + 28);
      const extraLen = buf.readUInt16LE(at + 30);
      const commentLen = buf.readUInt16LE(at + 32);
      const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
      this.entries.set(name, {
        method: buf.readUInt16LE(at + 10),
        compressedSize: buf.readUInt32LE(at + 20),
        localHeader: buf.readUInt32LE(at + 42),
      });
      at += 46 + nameLen + extraLen + commentLen;
    }
  }

  get names(): readonly string[] {
    return [...this.entries.keys()];
  }

  /** The file's text (UTF-8); throws when the zip has no such file. */
  text(name: string): string {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`no ${name} in the zip`);
    const at = entry.localHeader;
    if (this.buf.readUInt32LE(at) !== LOCAL_SIG) throw new Error(`bad local header for ${name}`);
    const start = at + 30 + this.buf.readUInt16LE(at + 26) + this.buf.readUInt16LE(at + 28);
    const raw = this.buf.subarray(start, start + entry.compressedSize);
    if (entry.method === STORED) return raw.toString("utf8");
    if (entry.method === DEFLATED) return inflateRawSync(raw).toString("utf8");
    throw new Error(`${name}: compression method ${entry.method} not supported`);
  }

  private findEnd(): number {
    const stop = Math.max(0, this.buf.length - EOCD_MIN - COMMENT_MAX);
    for (let i = this.buf.length - EOCD_MIN; i >= stop; i -= 1) {
      if (this.buf.readUInt32LE(i) === EOCD_SIG) return i;
    }
    throw new Error("not a zip (no end of central directory)");
  }
}
