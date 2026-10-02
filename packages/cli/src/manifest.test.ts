import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MANIFEST_FORMAT,
  parseManifest,
  sha256File,
  verifyFile,
  type Manifest,
} from "./manifest.js";

const HASH = "a".repeat(64);

export function sampleManifest(overrides: Partial<Manifest> = {}): Manifest {
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
    files: { database: { path: "database.dump", sha256: HASH, bytes: 10 }, objects: null },
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
    [
      "a file path outside the backup",
      {
        files: {
          database: { path: "../etc/passwd", sha256: HASH, bytes: 1 },
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
    await writeFile(join(dir, "database.dump"), "hello");
    const ref = {
      path: "database.dump" as const,
      ...(await sha256File(join(dir, "database.dump"))),
    };
    await expect(verifyFile(dir, ref)).resolves.toBeUndefined();
    await writeFile(join(dir, "database.dump"), "hellO");
    await expect(verifyFile(dir, ref)).rejects.toThrow(/checksum/);
  });
});
