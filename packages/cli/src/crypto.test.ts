import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  decryptBuffer,
  decryptFile,
  deriveKeys,
  encryptBuffer,
  encryptStream,
  parseKeyMaterial,
  signManifest,
  verifyManifestSignature,
} from "./crypto.js";

const master = randomBytes(32);
const salt = randomBytes(16);

describe("parseKeyMaterial", () => {
  it("accepts base64 or hex of at least 32 bytes", () => {
    expect(parseKeyMaterial(master.toString("base64"))).toEqual(master);
    expect(parseKeyMaterial(`${master.toString("hex")}\n`)).toEqual(master);
  });

  it("rejects short or malformed keys without echoing them", () => {
    let message = "";
    try {
      parseKeyMaterial("c2hvcnQ=");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/at least 32 bytes/);
    expect(message).not.toContain("c2hvcnQ");
    expect(() => parseKeyMaterial("not a key!")).toThrow(/base64 or hex/);
  });

  it("rejects trivial keys of the right length", () => {
    expect(() => parseKeyMaterial("00".repeat(32))).toThrow(/does not look random/);
    expect(() => parseKeyMaterial(Buffer.from("password".repeat(4)).toString("base64"))).toThrow(
      /does not look random/,
    );
  });
});

describe("deriveKeys", () => {
  it("derives distinct encryption and MAC keys, bound to the salt", () => {
    const a = deriveKeys(master, salt);
    expect(a.enc.equals(a.mac)).toBe(false);
    expect(a.enc).toHaveLength(32);
    expect(deriveKeys(master, randomBytes(16)).enc.equals(a.enc)).toBe(false);
  });
});

describe("manifest signature", () => {
  const { mac } = deriveKeys(master, salt);
  const body = Buffer.from('{"a":1}');

  it("verifies the exact bytes it signed", () => {
    expect(verifyManifestSignature(mac, body, signManifest(mac, body))).toBe(true);
  });

  it("rejects modified bytes, another key, and malformed signatures", () => {
    const sig = signManifest(mac, body);
    expect(verifyManifestSignature(mac, Buffer.from('{"a":2}'), sig)).toBe(false);
    expect(verifyManifestSignature(deriveKeys(randomBytes(32), salt).mac, body, sig)).toBe(false);
    expect(verifyManifestSignature(mac, body, "zz")).toBe(false);
    expect(verifyManifestSignature(mac, body, "")).toBe(false);
  });
});

describe("AES-256-GCM", () => {
  const { enc } = deriveKeys(master, salt);

  it("round-trips a buffer and authenticates it with its file name", () => {
    const sealed = encryptBuffer(enc, "objects.jsonl.enc", Buffer.from("secret"));
    expect(sealed.data.toString("utf8")).not.toContain("secret");
    expect(decryptBuffer(enc, "objects.jsonl.enc", sealed).toString()).toBe("secret");
    expect(() => decryptBuffer(enc, "database.dump.enc", sealed)).toThrow(/decrypt/);
    const flipped = Buffer.from(sealed.data);
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() => decryptBuffer(enc, "objects.jsonl.enc", { ...sealed, data: flipped })).toThrow(
      /decrypt/,
    );
  });

  it("streams a file through and refuses a tampered one, leaving no plaintext behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kobe-crypto-"));
    const plain = randomBytes(300_000);
    const sealedPath = join(dir, "database.dump.enc");
    const header = await encryptStream(
      enc,
      "database.dump.enc",
      Readable.from([plain]),
      sealedPath,
    );
    const out = join(dir, "plain");
    await decryptFile(enc, "database.dump.enc", sealedPath, header, out);
    expect((await readFile(out)).equals(plain)).toBe(true);

    const bytes = await readFile(sealedPath);
    bytes[100] = (bytes[100] ?? 0) ^ 1;
    await writeFile(sealedPath, bytes);
    const out2 = join(dir, "plain2");
    await expect(decryptFile(enc, "database.dump.enc", sealedPath, header, out2)).rejects.toThrow(
      /decrypt/,
    );
    await expect(readFile(out2)).rejects.toThrow(/ENOENT/);
  });
});
