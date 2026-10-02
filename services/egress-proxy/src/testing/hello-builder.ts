/** Builds a minimal TLS 1.2-style ClientHello record (tests only). */
export function buildClientHello(options: {
  readonly serverName?: string;
  readonly extensions?: readonly { readonly type: number; readonly data: Buffer }[];
}): Buffer {
  const u16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);
  const ext = (type: number, data: Buffer) => Buffer.concat([u16(type), u16(data.length), data]);
  const exts: Buffer[] = [];
  if (options.serverName !== undefined) {
    const name = Buffer.from(options.serverName, "ascii");
    const entry = Buffer.concat([Buffer.from([0]), u16(name.length), name]);
    exts.push(ext(0, Buffer.concat([u16(entry.length), entry])));
  }
  for (const e of options.extensions ?? []) exts.push(ext(e.type, e.data));
  const extBlock = Buffer.concat(exts);
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32, 7),
    Buffer.from([0]), // session id
    u16(2),
    Buffer.from([0x13, 0x01]), // cipher suites
    Buffer.from([1, 0]), // compression
    u16(extBlock.length),
    extBlock,
  ]);
  const hs = Buffer.concat([
    Buffer.from([1, body.length >> 16, (body.length >> 8) & 0xff, body.length & 0xff]),
    body,
  ]);
  return Buffer.concat([Buffer.from([22, 3, 1]), u16(hs.length), hs]);
}
