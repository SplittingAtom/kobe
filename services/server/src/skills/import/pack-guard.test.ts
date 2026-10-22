import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ImportError } from "./fetch.js";
import { checkPack, packOf } from "./pack-guard.js";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A pack of one commit holding `files`, made by the git CLI. */
function packWith(files: Record<string, Buffer | string>): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), "kobe-pack-"));
  dirs.push(dir);
  const run = (args: string[], input?: string) =>
    execFileSync("git", args, {
      cwd: dir,
      input,
      env: { PATH: process.env.PATH ?? "", HOME: dir, GIT_CONFIG_NOSYSTEM: "1" },
    });
  run(["init", "-q"]);
  for (const [p, b] of Object.entries(files)) writeFileSync(path.join(dir, p), b);
  run(["add", "-A"]);
  run(["-c", "user.name=a", "-c", "user.email=a@x", "commit", "-qm", "c"]);
  return run(["pack-objects", "--stdout", "--revs", "-q"], "HEAD\n");
}

const CAPS = { maxObjectBytes: 10 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 };

describe("pack guard (KOBE-344 review)", () => {
  it("lets an ordinary pack through", () => {
    expect(() =>
      checkPack(packWith({ "SKILL.md": "# hi\n", "a.py": "print(1)\n" }), CAPS),
    ).not.toThrow();
  });

  it("refuses a tiny pack whose blob expands far beyond the per-file limit, before indexing", () => {
    const bomb = packWith({ "zeros.bin": Buffer.alloc(40 * 1024 * 1024) });
    expect(bomb.length).toBeLessThan(200 * 1024);
    let err: unknown;
    try {
      checkPack(bomb, CAPS);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ImportError);
    expect((err as ImportError).code).toBe("too_large");
  });

  it("refuses many objects that only together exceed the total", () => {
    const files = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [`f${i}.bin`, Buffer.alloc(1024 * 1024, i + 1)]),
    );
    expect(() =>
      checkPack(packWith(files), {
        maxObjectBytes: 2 * 1024 * 1024,
        maxTotalBytes: 4 * 1024 * 1024,
      }),
    ).toThrow(/too large/);
  });

  it("finds the pack in a side-band upload-pack answer", () => {
    const pack = packWith({ "SKILL.md": "# x\n" });
    const line = (payload: Buffer) =>
      Buffer.concat([Buffer.from((payload.length + 4).toString(16).padStart(4, "0")), payload]);
    const body = Buffer.concat([
      line(Buffer.from("NAK\n")),
      line(Buffer.concat([Buffer.from([2]), Buffer.from("Counting objects\n")])),
      line(Buffer.concat([Buffer.from([1]), pack.subarray(0, 10)])),
      line(Buffer.concat([Buffer.from([1]), pack.subarray(10)])),
      Buffer.from("0000"),
    ]);
    expect(Buffer.from(packOf(body) as Uint8Array).equals(pack)).toBe(true);
  });
});
