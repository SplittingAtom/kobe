import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PI_PRIVATE_PREFIX, preparePiPrivateDirs, sweepPiPrivateDirs } from "./exec-wiring.js";
import { mapHome } from "../kobe-exec/tools.js";
import type { ExecTransport } from "../kobe-exec/client.js";

let base: string;
beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "kobe-private-"));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

// The identity's group is one this process holds, so the chown works unprivileged.
const identity = { uid: 2000, gid: process.getgid?.() ?? 0 };

const mode = async (dir: string) => (await stat(dir)).mode & 0o777;

describe("preparePiPrivateDirs (KOBE-196)", () => {
  it("makes agent-owned, Pi-group directories under the scratch volume: home private, tmp world-readable", async () => {
    const dirs = await preparePiPrivateDirs(base, identity);
    expect(dirs.root).toMatch(new RegExp(`^${base}/${PI_PRIVATE_PREFIX}[0-9a-f]{32}$`));
    expect(dirs.home).toBe(path.join(dirs.root, "home"));
    expect(dirs.tmp).toBe(path.join(dirs.root, "tmp"));
    expect(await mode(dirs.root)).toBe(0o755);
    expect(await mode(dirs.home)).toBe(0o770);
    expect(await mode(dirs.tmp)).toBe(0o775);
    for (const dir of [dirs.root, dirs.home, dirs.tmp]) {
      const info = await stat(dir);
      expect(info.uid).toBe(process.getuid?.());
      expect(info.gid).toBe(identity.gid);
    }
  });

  it("without the executor (KOBE-228) nobody outside the Pi's group gets in: root, home and tmp are 2770", async () => {
    const dirs = await preparePiPrivateDirs(base, identity, {
      partner: false,
    });
    for (const dir of [dirs.root, dirs.home, dirs.tmp]) {
      const info = await stat(dir);
      expect(info.mode & 0o7777).toBe(0o2770);
      expect(info.gid).toBe(identity.gid);
    }
  });

  it("without an identity (no uid separation) the directories are 0700 and the agent's", async () => {
    const dirs = await preparePiPrivateDirs(base, undefined, {
      partner: false,
    });
    for (const dir of [dirs.root, dirs.home, dirs.tmp]) {
      expect((await stat(dir)).mode & 0o7777).toBe(0o700);
    }
  });

  it("KOBE-235: a squatted name never stops a Pi from starting: it retries with a fresh one and leaves the squatter's directory alone", async () => {
    await mkdir(path.join(base, `${PI_PRIVATE_PREFIX}squat1`));
    await writeFile(path.join(base, `${PI_PRIVATE_PREFIX}squat2`), "a file, not a dir");
    const names = ["squat1", "squat2", "fresh"].map((n) => `${PI_PRIVATE_PREFIX}${n}`);
    const dirs = await preparePiPrivateDirs(base, identity, {
      newName: () => names.shift() ?? "unexpected",
    });
    expect(dirs.root).toBe(path.join(base, `${PI_PRIVATE_PREFIX}fresh`));
    expect(await mode(dirs.home)).toBe(0o770);
    expect(await readdir(path.join(base, `${PI_PRIVATE_PREFIX}squat1`))).toEqual([]);
  });

  it("KOBE-235: names are unguessable (random, different every time)", async () => {
    const a = await preparePiPrivateDirs(base, undefined, { partner: false });
    const b = await preparePiPrivateDirs(base, undefined, { partner: false });
    expect(a.root).not.toBe(b.root);
  });

  it("KOBE-235: gives up with a clear error when every name keeps existing", async () => {
    await mkdir(path.join(base, "same"));
    await expect(preparePiPrivateDirs(base, undefined, { newName: () => "same" })).rejects.toThrow(
      /could not create a private directory/,
    );
  });

  it("is swept at start-up: only its own prefix, with what a Pi left inside", async () => {
    const dirs = await preparePiPrivateDirs(base, identity);
    await mkdir(path.join(dirs.tmp, "jiti"));
    await writeFile(path.join(dirs.tmp, "jiti", "x.mjs"), "x");
    await mkdir(path.join(base, "keep-me"));
    expect(await sweepPiPrivateDirs(base, undefined)).toBe(1);
    await expect(stat(dirs.root)).rejects.toThrow();
    expect((await stat(path.join(base, "keep-me"))).isDirectory()).toBe(true);
  });
});

describe("mapHome (KOBE-196)", () => {
  function recorder() {
    const seen: Record<string, unknown>[] = [];
    const transport: ExecTransport = {
      request: (body) => {
        seen.push(body);
        return Promise.resolve({ ok: true, fields: {} });
      },
    };
    return { seen, transport };
  }
  const homes = { piHome: "/tmp/kobe-pi-x/home", toolHome: "/home/kobe" };

  it("rewrites a path or cwd under Pi's private home to the tools' home, nothing else", async () => {
    const { seen, transport } = recorder();
    const mapped = mapHome(transport, homes);
    await mapped.request({ op: "read", path: "/tmp/kobe-pi-x/home/.bashrc", offset: 0, length: 1 });
    await mapped.request({ op: "exec", cwd: "/tmp/kobe-pi-x/home", command: "ls" });
    await mapped.request({ op: "stat", path: "/tmp/kobe-pi-x/homework" });
    await mapped.request({ op: "stat", path: "/workspace/a" });
    expect(seen.map((b) => b.path ?? b.cwd)).toEqual([
      "/home/kobe/.bashrc",
      "/home/kobe",
      "/tmp/kobe-pi-x/homework",
      "/workspace/a",
    ]);
  });
});
