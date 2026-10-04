import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PI_OWN_FILES, sweepRuntimeDir, unexpectedEntries } from "./runtime-dir.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function processDir(root: string, piFiles: readonly string[] = [...PI_OWN_FILES]) {
  const runtime = await mkdtemp(path.join(root, "pi-"));
  await mkdir(path.join(runtime, "agent"), { mode: 0o700 });
  await writeFile(path.join(runtime, "model.json"), "{}", { mode: 0o600 });
  for (const f of piFiles) await writeFile(path.join(runtime, "agent", f), "{}");
  return runtime;
}

describe("runtime directory tripwire", () => {
  it("accepts what the agent and Pi write, including a writer temp file and Pi's lock", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kobe-runtime-"));
    const runtime = await processDir(dir);
    await writeFile(path.join(runtime, `model.json.${"a".repeat(16)}.tmp`), "{}");
    expect(await unexpectedEntries(runtime)).toEqual([]);
  });

  it("reports anything else: Pi config a sibling could plant, or a stray top-level file", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kobe-runtime-"));
    const runtime = await processDir(dir, ["auth.json"]);
    await writeFile(path.join(runtime, "agent", "settings.json"), '{"shellPath":"/tmp/evil"}');
    await mkdir(path.join(runtime, "agent", "bin"));
    await writeFile(path.join(runtime, "notes.txt"), "x");
    expect((await unexpectedEntries(runtime)).sort()).toEqual([
      "agent/bin",
      "agent/settings.json",
      "notes.txt",
    ]);
    await rm(path.join(runtime, "agent"), { recursive: true });
    expect(await unexpectedEntries(runtime)).toEqual(["notes.txt", "<agent missing>"]);
    expect(await unexpectedEntries(path.join(dir, "gone"))).toEqual(["<runtime dir missing>"]);
  });

  it("sweeps stale per-process directories at start-up and keeps everything else", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kobe-runtime-"));
    const root = path.join(dir, "kobe-pi");
    await mkdir(root);
    await processDir(root);
    await processDir(root);
    await mkdir(path.join(root, "version-probe"));
    await writeFile(path.join(root, "other"), "x");
    expect(await sweepRuntimeDir(root)).toBe(2);
    expect((await readdir(root)).sort()).toEqual(["other", "version-probe"]);
    // A missing root is created (0700).
    expect(await sweepRuntimeDir(path.join(dir, "fresh"))).toBe(0);
    expect(await readdir(path.join(dir, "fresh"))).toEqual([]);
  });
});
