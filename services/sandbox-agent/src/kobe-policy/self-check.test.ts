import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findLaunchProblem } from "./self-check.js";

const OWN = "/opt/kobe/pi-extensions/kobe-policy/index.js";
const base = ["--mode", "rpc", "--session", "/w/s.jsonl", "--no-extensions", "--no-approve"];

describe("findLaunchProblem", () => {
  it("accepts kobe-policy as the only extension", () => {
    expect(findLaunchProblem([...base, "--extension", OWN], OWN, "/workspace")).toBeUndefined();
  });

  it("accepts kobe-policy after other extensions (short flags too)", () => {
    expect(
      findLaunchProblem([...base, "-e", "builtin:mcp", "-e", "/opt/x.js", "-e", OWN], OWN, "/w"),
    ).toBeUndefined();
    expect(findLaunchProblem(["-ne", "-e", OWN], OWN, "/w")).toBeUndefined();
  });

  it("refuses when another extension loads after kobe-policy", () => {
    expect(findLaunchProblem([...base, "-e", OWN, "-e", "/opt/later.js"], OWN, "/w")).toMatch(
      /not the last/,
    );
  });

  it("refuses when kobe-policy is not among the -e flags", () => {
    expect(findLaunchProblem([...base], OWN, "/w")).toMatch(/not the last/);
  });

  it("refuses without --no-extensions", () => {
    expect(findLaunchProblem(["--mode", "rpc", "-e", OWN], OWN, "/w")).toMatch(/--no-extensions/);
  });

  it("ignores flags after --", () => {
    expect(findLaunchProblem([...base, "-e", OWN, "--", "-e", "/x.js"], OWN, "/w")).toBeUndefined();
  });

  it("resolves relative paths against the cwd and follows symlinks", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kp-self-"));
    const real = path.join(dir, "index.js");
    await writeFile(real, "");
    await symlink(real, path.join(dir, "link.js"));
    expect(findLaunchProblem(["-ne", "-e", "./link.js"], real, dir)).toBeUndefined();
    expect(findLaunchProblem(["-ne", "-e", "./other.js"], real, dir)).toMatch(/not the last/);
  });
});
