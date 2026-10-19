import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixtureUrl, prepareFixtures } from "./fixtures.js";

let ws = "";
let outside = "";
beforeEach(async () => {
  ws = await mkdtemp(path.join(tmpdir(), "kobe-eval-fix-"));
  outside = await mkdtemp(path.join(tmpdir(), "kobe-eval-out-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const fetcher = (files: Record<string, string>) => async (p: string) => Buffer.from(files[p] ?? "");

describe("prepareFixtures (KOBE-325)", () => {
  it("writes each fixture where the case says, checked against its hash", async () => {
    await prepareFixtures(
      ws,
      { files: [{ path: "data/sales.csv", sha256: sha("a,b"), size: 3 }] },
      fetcher({ "data/sales.csv": "a,b" }),
    );
    expect(await readFile(path.join(ws, "data/sales.csv"), "utf8")).toBe("a,b");
  });

  it("refuses bytes that do not match the listed hash", async () => {
    await expect(
      prepareFixtures(
        ws,
        { files: [{ path: "x.txt", sha256: sha("good"), size: 4 }] },
        fetcher({ "x.txt": "evil" }),
      ),
    ).rejects.toThrow();
    await expect(lstat(path.join(ws, "x.txt"))).rejects.toThrow();
  });

  it("never writes through a linked parent", async () => {
    await symlink(outside, path.join(ws, "data"));
    await expect(
      prepareFixtures(
        ws,
        { files: [{ path: "data/x.txt", sha256: sha("x"), size: 1 }] },
        fetcher({ "data/x.txt": "x" }),
      ),
    ).rejects.toThrow();
    await expect(lstat(path.join(outside, "x.txt"))).rejects.toThrow();
  });

  it("asks the server's sandbox listener for the path", () => {
    expect(fixtureUrl("wss://server.kobe.internal", "a b/c.csv")).toBe(
      "https://server.kobe.internal/v1/sandbox/skill-evals/fixtures?path=a+b%2Fc.csv",
    );
  });
});
