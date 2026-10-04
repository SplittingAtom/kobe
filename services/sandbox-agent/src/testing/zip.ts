import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";

/**
 * Builds a stored (uncompressed) zip like the server's canonical bundles, with switches to make
 * it hostile for tests: entry attributes (symlink, device), flags, methods, comment, junk.
 */
export interface TestEntry {
  readonly name: string;
  readonly data?: string | Uint8Array;
  /** Unix mode bits for the external attributes (e.g. 0o120777 for a symlink). */
  readonly mode?: number;
  readonly method?: number;
  readonly flags?: number;
  /** CRC to claim instead of the real one. */
  readonly crc?: number;
}

export interface TestZipOptions {
  readonly comment?: string;
  readonly junkBefore?: Uint8Array;
}

const u16 = (n: number) => Buffer.from([n & 0xff, (n >>> 8) & 0xff]);
const u32 = (n: number) =>
  Buffer.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

export function testZip(entries: readonly TestEntry[], options: TestZipOptions = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.from(e.data ?? "");
    const crc = e.crc ?? crc32(data);
    const method = e.method ?? 0;
    const flags = e.flags ?? 0;
    const common = [
      u16(20),
      u16(flags),
      u16(method),
      u16(0x6000),
      u16(0x5021),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
    ];
    const local = Buffer.concat([u32(0x04034b50), ...common, name, data]);
    centrals.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        ...common,
        u16(0),
        u16(0),
        u16(0),
        u32(((e.mode ?? 0) << 16) >>> 0),
        u32(offset),
        name,
      ]),
    );
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const comment = Buffer.from(options.comment ?? "");
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(cd.length),
    u32(offset),
    u16(comment.length),
    comment,
  ]);
  const body = Buffer.concat([...locals, cd, eocd]);
  return options.junkBefore ? Buffer.concat([options.junkBefore, body]) : body;
}

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export const SKILL_MD_TEXT = "---\nname: demo\ndescription: Demo skill\n---\nHello\n";

/** A well-formed bundle: SKILL.md plus a nested script. */
export const goodBundle = (extra: readonly TestEntry[] = []): Buffer =>
  testZip([
    { name: "SKILL.md", data: SKILL_MD_TEXT },
    { name: "scripts/run.sh", data: "echo hi\n" },
    ...extra,
  ]);

/** A canonical zip made by the server's own packer (fflate, level 0), for cross-checking. */
export const SERVER_CANONICAL_ZIP_BASE64 =
  "UEsDBBQAAAAAAABgIVCCPQmkMQAAADEAAAAIAAAAU0tJTEwubWQtLS0KbmFtZTogZGVtbwpkZXNjcmlwdGlvbjogRGVtbyBza2lsbAotLS0KSGVsbG8KUEsDBBQAAAAAAABgIVAzRq4KCAAAAAgAAAAOAAAAc2NyaXB0cy9ydW4uc2hlY2hvIGhpClBLAwQUAAAIAAAAYCFQtR+48wMAAAADAAAAEgAAAHLDqWbDqXJlbmNlcy/DqS5tZMOpClBLAQIUABQAAAAAAABgIVCCPQmkMQAAADEAAAAIAAAAAAAAAAAAAAAAAAAAAABTS0lMTC5tZFBLAQIUABQAAAAAAABgIVAzRq4KCAAAAAgAAAAOAAAAAAAAAAAAAAAAAFcAAABzY3JpcHRzL3J1bi5zaFBLAQIUABQAAAgAAABgIVC1H7jzAwAAAAMAAAASAAAAAAAAAAAAAAAAAIsAAAByw6lmw6lyZW5jZXMvw6kubWRQSwUGAAAAAAMAAwCyAAAAvgAAAAAA";
