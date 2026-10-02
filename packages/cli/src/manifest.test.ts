import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveKeys, newSalt } from "./crypto.js";
import {
  DATABASE_FILE,
  MANIFEST_FILE,
  MANIFEST_FORMAT,
  MANIFEST_SIGNATURE_FILE,
  parseManifest,
  readSignedManifest,
  sha256File,
  verifyFile,
  writeSignedManifest,
  type Manifest,
} from "./manifest.js";

const HASH = "a".repeat(64);

function sampleManifest(overrides: Partial<Manifest> = {}, salt = "0".repeat(32)): Manifest {
  return {
    format: MANIFEST_FORMAT,
    createdAt: "2026-10-02T00:00:00.000Z",
    postgres: { serverVersion: "17.11", pgDumpVersion: "18.6" },
    migrations: [{ hash: HASH, createdAt: 1790905755499 }],
    tables: [
      { name: "users", rows: 2 },
      { name: "team_members", rows: 0 },
    ],
    excludedTables: [{ name: "sessions", reason: "bearer tokens" }],
    files: {
      database: {
        path: DATABASE_FILE,
        sha256: HASH,
        bytes: 10,
        iv: "1".repeat(24),
        tag: "2".repeat(32),
      },
      objects: null,
    },
    encryption: { cipher: "aes-256-gcm", kdf: "hkdf-sha256", salt },
    coverage: { schemas: ["public"], otherSchemasChecked: true, largeObjects: 0 },
    objectStorage: null,
    ...overrides,
  };
}

describe("manifest", () => {
  it("round-trips through JSON", () => {
    const m = sampleManifest();
    expect(parseManifest(JSON.stringify(m))).toEqual(m);
  });

  it.each([
    ["an unknown format", { format: "kobe-backup/99" }],
    ["no migrations", { migrations: [] }],
    ["a non-hex migration hash", { migrations: [{ hash: "x'; DROP", createdAt: 1 }] }],
    ["an unsafe table name", { tables: [{ name: 'users"; DROP TABLE x; --', rows: 1 }] }],
    ["a negative row count", { tables: [{ name: "users", rows: -1 }] }],
    ["no encryption", { encryption: undefined }],
    [
      "unchecked coverage",
      { coverage: { schemas: ["public"], otherSchemasChecked: false, largeObjects: 0 } },
    ],
    [
      "a file path outside the backup",
      {
        files: {
          database: {
            path: "../etc/passwd",
            sha256: HASH,
            bytes: 1,
            iv: "1".repeat(24),
            tag: "2".repeat(32),
          },
          objects: null,
        },
      },
    ],
  ])("rejects %s", (_label, override) => {
    const bad = { ...sampleManifest(), ...override };
    expect(() => parseManifest(JSON.stringify(bad))).toThrow(/manifest/i);
  });

  it("rejects a table listed twice", () => {
    const bad = sampleManifest({
      tables: [
        { name: "users", rows: 1 },
        { name: "users", rows: 1 },
      ],
    });
    expect(() => parseManifest(JSON.stringify(bad))).toThrow(/more than once/);
  });

  it("rejects text that is not JSON", () => {
    expect(() => parseManifest("not json")).toThrow(/manifest/i);
  });

  it("verifies file checksums and sizes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kobe-manifest-"));
    await writeFile(join(dir, DATABASE_FILE), "hello");
    const ref = {
      path: DATABASE_FILE,
      iv: "1".repeat(24),
      tag: "2".repeat(32),
      ...(await sha256File(join(dir, DATABASE_FILE))),
    } as const;
    await expect(verifyFile(dir, ref)).resolves.toBeUndefined();
    await writeFile(join(dir, DATABASE_FILE), "hellO");
    await expect(verifyFile(dir, ref)).rejects.toThrow(/checksum/);
  });
});

describe("signed manifest", () => {
  const master = randomBytes(32);

  async function signedDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "kobe-signed-"));
    const salt = newSalt();
    await writeSignedManifest(
      dir,
      sampleManifest({}, salt.toString("hex")),
      deriveKeys(master, salt),
    );
    return dir;
  }

  it("reads back what it signed", async () => {
    const { manifest } = await readSignedManifest(await signedDir(), master);
    expect(manifest.tables).toHaveLength(2);
  });

  it("refuses a modified manifest", async () => {
    const dir = await signedDir();
    const text = await readFile(join(dir, MANIFEST_FILE), "utf8");
    await writeFile(join(dir, MANIFEST_FILE), text.replace('"rows": 2', '"rows": 3'));
    await expect(readSignedManifest(dir, master)).rejects.toThrow(/signature does not verify/);
  });

  it("refuses another key", async () => {
    await expect(readSignedManifest(await signedDir(), randomBytes(32))).rejects.toThrow(
      /wrong backup key/,
    );
  });

  it("refuses an unsigned backup", async () => {
    const dir = await signedDir();
    await rm(join(dir, MANIFEST_SIGNATURE_FILE));
    await expect(readSignedManifest(dir, master)).rejects.toThrow(/unsigned/);
  });
});
