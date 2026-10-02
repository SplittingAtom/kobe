import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLEANUP_SIGNALS, makePrivateWorkDir, removeOnSignal } from "./workdir.js";

describe("makePrivateWorkDir", () => {
  it("creates a 0700 directory under the given base (KOBE_TMPDIR)", async () => {
    const base = await mkdtemp(join(tmpdir(), "kobe-base-"));
    const dir = await makePrivateWorkDir(base);
    expect(dir.startsWith(join(base, "kobe-restore-"))).toBe(true);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });
});

describe("removeOnSignal", () => {
  it("deletes the plaintext and exits non-zero on SIGINT/SIGTERM/SIGHUP", async () => {
    for (const [signal, code] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
      ["SIGHUP", 129],
    ] as const) {
      const dir = await makePrivateWorkDir();
      await writeFile(join(dir, "database.dump"), "plaintext");
      const exits: number[] = [];
      const cleanup = removeOnSignal(dir, (c) => exits.push(c));
      cleanup.handle(signal);
      await expect(stat(dir)).rejects.toThrow(/ENOENT/);
      expect(exits).toEqual([code]);
      cleanup.dispose();
    }
  });

  it("registers one listener per signal and removes it again", async () => {
    const before = CLEANUP_SIGNALS.map((s) => process.listenerCount(s));
    const cleanup = removeOnSignal(await makePrivateWorkDir(), () => undefined);
    expect(CLEANUP_SIGNALS.map((s) => process.listenerCount(s))).toEqual(before.map((n) => n + 1));
    cleanup.dispose();
    expect(CLEANUP_SIGNALS.map((s) => process.listenerCount(s))).toEqual(before);
  });
});
