import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { piCommand } from "./pi-command.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kobe-pi-command-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("piCommand (KOBE-71: no inspector through SIGUSR1)", () => {
  it("runs a Node script found on PATH through a symlink as node --disable-sigusr1 <script>", async () => {
    const script = path.join(dir, "cli.js");
    await writeFile(script, "#!/usr/bin/env node\n");
    await chmod(script, 0o755);
    await symlink(script, path.join(dir, "pi"));
    const real = await import("node:fs/promises").then((fs) => fs.realpath(script));
    expect(await piCommand("pi", `/nonexistent:${dir}`, "/usr/local/bin/node")).toEqual({
      bin: "/usr/local/bin/node",
      prefix: ["--disable-sigusr1", real],
    });
  });

  it("recognises a node shebang without a .js name, and leaves other programs alone", async () => {
    const node = path.join(dir, "fake");
    await writeFile(node, "#!/usr/bin/env -S node --no-warnings\n");
    await chmod(node, 0o755);
    expect((await piCommand(node, undefined, "/n")).prefix[0]).toBe("--disable-sigusr1");
    const shell = path.join(dir, "tool");
    await writeFile(shell, "#!/bin/sh\n");
    await chmod(shell, 0o755);
    expect(await piCommand(shell, undefined, "/n")).toEqual({ bin: shell, prefix: [] });
    expect(await piCommand("missing-pi", dir, "/n")).toEqual({ bin: "missing-pi", prefix: [] });
    expect(await piCommand(path.join(dir, "gone"), undefined, "/n")).toEqual({
      bin: path.join(dir, "gone"),
      prefix: [],
    });
  });
});
