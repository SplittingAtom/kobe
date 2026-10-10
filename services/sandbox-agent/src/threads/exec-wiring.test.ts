import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
    const runtime = path.join(base, "run", "pi-AbC123");
    const dirs = await preparePiPrivateDirs(base, runtime, identity);
    expect(dirs.root).toBe(path.join(base, `${PI_PRIVATE_PREFIX}pi-AbC123`));
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

  it("refuses a name that already exists (never reuses what another uid may have made)", async () => {
    const runtime = path.join(base, "pi-X");
    await preparePiPrivateDirs(base, runtime, identity);
    await expect(preparePiPrivateDirs(base, runtime, identity)).rejects.toThrow(/EEXIST/);
  });

  it("is swept at start-up: only its own prefix, with what a Pi left inside", async () => {
    const dirs = await preparePiPrivateDirs(base, path.join(base, "pi-Y"), identity);
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
