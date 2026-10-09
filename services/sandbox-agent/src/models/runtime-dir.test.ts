import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PI_OWN_FILES,
  ensureRuntimeRoot,
  piModelsStoreText,
  removeRuntimeDir,
  sweepRuntimeDir,
  unexpectedEntries,
} from "./runtime-dir.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function processDir(root: string, piFiles: readonly string[] = [...PI_OWN_FILES]) {
  const runtime = await mkdtemp(path.join(root, "pi-"));
  await mkdir(path.join(runtime, "agent"), { mode: 0o700 });
  await writeFile(path.join(runtime, "model.json"), "{}", { mode: 0o600 });
  for (const f of piFiles) {
    if (f.endsWith(".lock")) await mkdir(path.join(runtime, "agent", f));
    else await writeFile(path.join(runtime, "agent", f), "{}");
  }
  return runtime;
}

describe("runtime directory tripwire", () => {
  it("accepts what the agent and Pi write, including a writer temp file and Pi's lock", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kobe-runtime-"));
    const runtime = await processDir(dir);
    await writeFile(path.join(runtime, `model.json.${"a".repeat(16)}.tmp`), "{}");
    expect(await unexpectedEntries(runtime)).toEqual([]);
  });

  it("accepts the egress token file and its writer's temp file (KOBE-39), as files only", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kobe-runtime-"));
    const runtime = await processDir(dir);
    await writeFile(path.join(runtime, "egress-token"), "t\n", { mode: 0o600 });
    await writeFile(path.join(runtime, `egress-token.${"b".repeat(16)}.tmp`), "t\n");
    expect(await unexpectedEntries(runtime)).toEqual([]);
    await rm(path.join(runtime, "egress-token"));
    await mkdir(path.join(runtime, "egress-token"));
    expect(await unexpectedEntries(runtime)).toEqual(["egress-token (dir)"]);
  });

  it("reports anything else: Pi config a sibling could plant, or a stray top-level file", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kobe-runtime-"));
    const runtime = await processDir(dir, ["auth.json"]);
    await writeFile(path.join(runtime, "agent", "SYSTEM.md"), "evil");
    await mkdir(path.join(runtime, "agent", "bin"));
    await writeFile(path.join(runtime, "notes.txt"), "x");
    expect((await unexpectedEntries(runtime)).sort()).toEqual([
      "agent/SYSTEM.md",
      "agent/bin",
      "notes.txt",
    ]);
    await rm(path.join(runtime, "agent"), { recursive: true });
    expect(await unexpectedEntries(runtime)).toEqual(["notes.txt", "<agent missing>"]);
    expect(await unexpectedEntries(path.join(dir, "gone"))).toEqual(["<runtime dir missing>"]);
  });

  it("tolerates an expected entry vanishing between readdir and lstat (the writer's rename)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kobe-runtime-"));
    const runtime = await processDir(dir, ["auth.json"]);
    // readdir lists it, lstat finds it gone: a temp file renamed into place meanwhile.
    const temp = path.join(runtime, `model.json.${"b".repeat(16)}.tmp`);
    await writeFile(temp, "{}");
    const { readdir: realReaddir } = await import("node:fs/promises");
    const names = await realReaddir(runtime);
    expect(names).toContain(path.basename(temp));
    await rm(temp);
    expect(await unexpectedEntries(runtime)).toEqual([]);
  });

  it("checks kinds with lstat: symlinks, a file where Pi's lock dir belongs, a linked agent dir", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kobe-runtime-"));
    const victim = path.join(dir, "victim");
    await writeFile(victim, "x");
    const runtime = await processDir(dir, ["models-store.json"]);
    await symlink(victim, path.join(runtime, "agent", "auth.json"));
    await writeFile(path.join(runtime, "agent", "auth.json.lock"), "not a dir");
    await mkdir(path.join(runtime, "agent", "models-store.json.lock")); // Pi's store lock: fine
    expect((await unexpectedEntries(runtime)).sort()).toEqual([
      "agent/auth.json (symlink)",
      "agent/auth.json.lock (file)",
    ]);
    // model.json replaced by a symlink; agent/ replaced by a symlink to another directory.
    const other = await processDir(dir);
    await rm(path.join(other, "model.json"));
    await symlink(victim, path.join(other, "model.json"));
    const realAgent = path.join(dir, "elsewhere");
    await mkdir(realAgent);
    await rm(path.join(other, "agent"), { recursive: true });
    await symlink(realAgent, path.join(other, "agent"));
    expect((await unexpectedEntries(other)).sort()).toEqual([
      "agent (symlink)",
      "model.json (symlink)",
    ]);
  });

  it("reads Pi's catalog store as text, null when absent or not a regular file", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kobe-runtime-"));
    const runtime = await processDir(dir, ["auth.json"]);
    expect(await piModelsStoreText(runtime)).toBeNull();
    await writeFile(
      path.join(runtime, "agent", "models-store.json"),
      '{"b": 1, "a": {"y": [2], "x": null}}',
    );
    expect(await piModelsStoreText(runtime)).toBe('{"a":{"x":null,"y":[2]},"b":1}');
    // Same data, other formatting (Pi's own rewrite): the same canonical text.
    await writeFile(
      path.join(runtime, "agent", "models-store.json"),
      '{"a":{"x":null,"y":[2]},"b":1}',
    );
    expect(await piModelsStoreText(runtime)).toBe('{"a":{"x":null,"y":[2]},"b":1}');
    await writeFile(path.join(runtime, "agent", "models-store.json"), "{not json");
    expect(await piModelsStoreText(runtime)).toBe("<unparsable:{not json>");
    await rm(path.join(runtime, "agent", "models-store.json"));
    await mkdir(path.join(runtime, "agent", "models-store.json"));
    expect(await piModelsStoreText(runtime)).toBeNull();
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

describe("runtime root and removal (KOBE-71)", () => {
  it("is the agent's own directory: 0711 under Pi identities (reach, never list), else 0700", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kobe-runtime-"));
    const root = path.join(dir, "kobe-pi");
    await ensureRuntimeRoot(root, true);
    expect((await stat(root)).mode & 0o777).toBe(0o711);
    await ensureRuntimeRoot(root, false);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
  });

  it("refuses a root that is not a real directory (planted link)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kobe-runtime-"));
    await mkdir(path.join(dir, "elsewhere"));
    await symlink(path.join(dir, "elsewhere"), path.join(dir, "kobe-pi"));
    await expect(ensureRuntimeRoot(path.join(dir, "kobe-pi"), true)).rejects.toThrow(
      /not the agent's own directory/,
    );
  });

  it("under Pi identities, refuses a root anyone can rename (a non-sticky shared parent)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kobe-runtime-"));
    const shared = path.join(dir, "shared");
    await mkdir(shared);
    await chmod(shared, 0o777);
    await expect(ensureRuntimeRoot(path.join(shared, "kobe-pi"), true)).rejects.toThrow(
      /lets other users rename/,
    );
    // Sticky, like /tmp or a memory-backed emptyDir: the agent's entries are its own.
    await chmod(shared, 0o1777);
    await expect(ensureRuntimeRoot(path.join(shared, "kobe-pi"), true)).resolves.toBeUndefined();
    // Without identities only the agent uses it: no such requirement.
    await chmod(shared, 0o777);
    await expect(ensureRuntimeRoot(path.join(shared, "kobe-pi"), false)).resolves.toBeUndefined();
  });

  it("removes a runtime directory with everything in it", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kobe-runtime-"));
    const runtime = await processDir(dir);
    await removeRuntimeDir(runtime);
    await expect(lstat(runtime)).rejects.toThrow();
  });
});
