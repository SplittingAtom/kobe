/**
 * Reads the server name (SNI) from a TLS ClientHello (RFC 8446 §4.1.2, RFC 6066 §3) without
 * terminating TLS: the egress proxy never decrypts traffic, it only checks that the name the
 * client asks the server for is the host it was allowed to CONNECT to (spec D28 "SNI/Host match").
 *
 * The handshake message may span several TLS records; bytes are accumulated up to
 * MAX_CLIENT_HELLO_BYTES. Anything that is not a well-formed TLS handshake starting with a
 * ClientHello is `invalid` (plain HTTP, SSH and other protocols tunnelled through CONNECT included).
 */
export const MAX_CLIENT_HELLO_BYTES = 64 * 1024;

const CONTENT_HANDSHAKE = 22;
const HANDSHAKE_CLIENT_HELLO = 1;
const EXT_SERVER_NAME = 0;
const NAME_TYPE_HOST = 0;
const MAX_RECORD = 16_384 + 2_048;

export type ClientHelloResult =
  | { readonly status: "incomplete" }
  | { readonly status: "invalid"; readonly why: string }
  | { readonly status: "ok"; readonly serverName: string | undefined };

const invalid = (why: string): ClientHelloResult => ({ status: "invalid", why });

/**
 * Walks TLS records, collecting handshake bytes until the ClientHello is complete. Records after
 * it (e.g. 0-RTT early data) are not inspected.
 */
export function parseClientHello(data: Buffer): ClientHelloResult {
  if (data.length > 0 && data[0] !== CONTENT_HANDSHAKE) {
    return invalid("not a TLS handshake record");
  }
  const parts: Buffer[] = [];
  let collected = 0;
  let offset = 0;
  for (;;) {
    if (collected >= 4) {
      const hs = Buffer.concat(parts);
      if (hs[0] !== HANDSHAKE_CLIENT_HELLO) {
        return invalid("first handshake message is not a ClientHello");
      }
      const length = hs.readUIntBE(1, 3);
      if (length > MAX_CLIENT_HELLO_BYTES) return invalid("ClientHello too large");
      if (hs.length >= 4 + length) return readServerName(hs.subarray(4, 4 + length));
    }
    if (offset + 5 > data.length) break;
    const length = data.readUInt16BE(offset + 3);
    if (data[offset] !== CONTENT_HANDSHAKE) return invalid("not a TLS handshake record");
    if (data[offset + 1] !== 3) return invalid("not a TLS record version");
    if (length === 0 || length > MAX_RECORD) return invalid("bad TLS record length");
    if (offset + 5 + length > data.length) break;
    parts.push(data.subarray(offset + 5, offset + 5 + length));
    collected += length;
    offset += 5 + length;
  }
  if (data.length > MAX_CLIENT_HELLO_BYTES) return invalid("ClientHello too large");
  return { status: "incomplete" };
}

/** Bounds-checked cursor over the ClientHello body. */
class Reader {
  offset = 0;
  constructor(private readonly buf: Buffer) {}
  get remaining(): number {
    return this.buf.length - this.offset;
  }
  skip(n: number): boolean {
    if (n > this.remaining) return false;
    this.offset += n;
    return true;
  }
  u8(): number | undefined {
    if (this.remaining < 1) return undefined;
    return this.buf[this.offset++];
  }
  u16(): number | undefined {
    if (this.remaining < 2) return undefined;
    const v = this.buf.readUInt16BE(this.offset);
    this.offset += 2;
    return v;
  }
  bytes(n: number): Buffer | undefined {
    if (n > this.remaining) return undefined;
    const b = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return b;
  }
  vector8(): Buffer | undefined {
    const n = this.u8();
    return n === undefined ? undefined : this.bytes(n);
  }
  vector16(): Buffer | undefined {
    const n = this.u16();
    return n === undefined ? undefined : this.bytes(n);
  }
}

function readServerName(body: Buffer): ClientHelloResult {
  const r = new Reader(body);
  if (!r.skip(2 + 32)) return invalid("truncated ClientHello"); // legacy_version, random
  if (r.vector8() === undefined) return invalid("truncated session id");
  if (r.vector16() === undefined) return invalid("truncated cipher suites");
  if (r.vector8() === undefined) return invalid("truncated compression methods");
  if (r.remaining === 0) return { status: "ok", serverName: undefined };
  const extensions = r.vector16();
  if (extensions === undefined || r.remaining !== 0) return invalid("bad extensions block");
  const ext = new Reader(extensions);
  let serverName: string | undefined;
  const seen = new Set<number>();
  while (ext.remaining > 0) {
    const type = ext.u16();
    const data = ext.vector16();
    if (type === undefined || data === undefined) return invalid("truncated extension");
    if (seen.has(type)) return invalid("duplicate extension");
    seen.add(type);
    if (type !== EXT_SERVER_NAME) continue;
    const list = new Reader(data);
    const names = list.vector16();
    if (names === undefined || list.remaining !== 0) return invalid("bad server_name extension");
    const entries = new Reader(names);
    while (entries.remaining > 0) {
      const nameType = entries.u8();
      const name = entries.vector16();
      if (nameType === undefined || name === undefined) return invalid("bad server_name entry");
      if (nameType !== NAME_TYPE_HOST) continue;
      // RFC 6066: at most one name of each type.
      if (serverName !== undefined) return invalid("several host names in server_name");
      if (name.length === 0 || !/^[\x21-\x7e]+$/.test(name.toString("latin1"))) {
        return invalid("server name is not printable ASCII");
      }
      serverName = name.toString("ascii");
    }
  }
  return { status: "ok", serverName };
}
