import { beforeAll, describe, expect, it } from "vitest";
import { MAX_CLIENT_HELLO_BYTES, parseClientHello } from "./client-hello.js";
import { captureClientHello } from "./testing/client-hello.js";

/** A ClientHello split into two TLS records (allowed by RFC 8446 §5.1). */
function splitIntoRecords(hello: Buffer): Buffer {
  const fragment = hello.subarray(5);
  const cut = 40;
  const record = (part: Buffer) =>
    Buffer.concat([Buffer.from([22, 3, 1, part.length >> 8, part.length & 0xff]), part]);
  return Buffer.concat([record(fragment.subarray(0, cut)), record(fragment.subarray(cut))]);
}

let hello: Buffer;
beforeAll(async () => {
  hello = await captureClientHello("pypi.org");
});

describe("parseClientHello", () => {
  it("reads the SNI of a real TLS ClientHello", () => {
    expect(parseClientHello(hello)).toEqual({ status: "ok", serverName: "pypi.org" });
  });

  it("asks for more bytes until the whole message has arrived, at any cut", () => {
    for (const n of [0, 1, 4, 5, 9, 60, hello.length - 1]) {
      expect(parseClientHello(hello.subarray(0, n)).status, String(n)).toBe("incomplete");
    }
  });

  it("reassembles a ClientHello fragmented over several records", () => {
    expect(parseClientHello(splitIntoRecords(hello))).toEqual({
      status: "ok",
      serverName: "pypi.org",
    });
  });

  it("reports no server name when the client sends none", async () => {
    const bare = await captureClientHello(undefined);
    expect(parseClientHello(bare)).toEqual({ status: "ok", serverName: undefined });
  });

  it("refuses non-TLS protocols tunnelled through CONNECT", () => {
    for (const text of ["GET / HTTP/1.1\r\nHost: pypi.org\r\n\r\n", "SSH-2.0-OpenSSH_9.6\r\n"]) {
      expect(parseClientHello(Buffer.from(text)).status).toBe("invalid");
    }
  });

  it("refuses a handshake that does not start with a ClientHello, and oversized input", () => {
    const tampered = Buffer.from(hello);
    tampered[5] = 2; // ServerHello
    expect(parseClientHello(tampered).status).toBe("invalid");
    expect(parseClientHello(Buffer.alloc(MAX_CLIENT_HELLO_BYTES + 1, 22)).status).toBe("invalid");
  });

  it("ignores records after a complete ClientHello (0-RTT early data)", () => {
    const early = Buffer.concat([hello, Buffer.from([23, 3, 3, 0, 2, 0xab, 0xcd])]);
    expect(parseClientHello(early)).toEqual({ status: "ok", serverName: "pypi.org" });
  });

  it("never throws on truncated or corrupted input (fuzz)", () => {
    for (let i = 0; i < 2000; i++) {
      const copy = Buffer.from(hello);
      const at = 5 + Math.floor(Math.random() * (copy.length - 5));
      copy[at] = Math.floor(Math.random() * 256);
      expect(() =>
        parseClientHello(copy.subarray(0, 5 + Math.floor(Math.random() * copy.length))),
      ).not.toThrow();
    }
  });
});
