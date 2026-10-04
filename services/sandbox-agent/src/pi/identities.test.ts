import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PiIdentities,
  PiIdentityError,
  checkHelperFile,
  identityUids,
  loadPiIdentities,
  type HelperRunner,
} from "./identities.js";

/** Records helper invocations; answers with `code` (or per-call answers). */
function fakeRunner(answer: (args: readonly string[]) => { code: number | null; stderr: string }) {
  const calls: string[][] = [];
  const run: HelperRunner = async (_helper, args) => {
    calls.push([...args]);
    return answer(args);
  };
  return { calls, run };
}

const okRunner = () => fakeRunner(() => ({ code: 0, stderr: "" }));

describe("PiIdentities (KOBE-71)", () => {
  it("hands out each identity once and waits while all are in use", async () => {
    const ids = new PiIdentities("/helper", [2001, 2000], okRunner().run);
    expect(ids.size).toBe(2);
    const a = await ids.acquire();
    const b = await ids.acquire();
    expect([a.uid, b.uid]).toEqual([2000, 2001]);
    expect(a.gid).toBe(a.uid);
    let third: number | undefined;
    const waiting = ids.acquire().then((identity) => (third = identity.uid));
    await new Promise((r) => setTimeout(r, 10));
    expect(third).toBeUndefined();
    ids.release(b);
    await waiting;
    expect(third).toBe(2001);
    // Releasing twice, or an identity it does not own, changes nothing.
    ids.release(a);
    ids.release(a);
    ids.release({ uid: 2000, gid: 2000 });
    expect(ids.available).toBe(1);
  });

  it("retries kill-all before giving an identity up", async () => {
    let calls = 0;
    const flaky = fakeRunner(() =>
      ++calls < 3 ? { code: 71, stderr: "busy" } : { code: 0, stderr: "" },
    );
    const ids = new PiIdentities("/helper", [2000], flaky.run);
    await ids.killAllPatiently({ uid: 2000, gid: 2000 }, [1, 1, 1]);
    expect(calls).toBe(3);
    const stuck = new PiIdentities(
      "/helper",
      [2000],
      fakeRunner(() => ({ code: 71, stderr: "busy" })).run,
    );
    await expect(stuck.killAllPatiently({ uid: 2000, gid: 2000 }, [1, 1])).rejects.toThrow(/busy/);
  });

  it("gives up waiting for an identity after a while", async () => {
    const ids = new PiIdentities("/helper", [2000], okRunner().run);
    const held = await ids.acquire();
    await expect(ids.acquire(20)).rejects.toThrow(/no Pi identity is free/);
    // The timed-out waiter is gone: a release goes back to the pool.
    ids.release(held);
    expect(ids.available).toBe(1);
  });

  it("refuses uids outside the Pi identity range", () => {
    expect(() => new PiIdentities("/helper", [1000])).toThrow(PiIdentityError);
    expect(() => new PiIdentities("/helper", [2064])).toThrow(PiIdentityError);
    expect(() => new PiIdentities("/helper", [])).toThrow(PiIdentityError);
  });

  it("wraps a command for the helper, restoring TMPDIR (dropped in secure-execution mode)", () => {
    const ids = new PiIdentities("/helper", [2000], okRunner().run);
    const identity = { uid: 2000, gid: 2000 };
    expect(ids.command(identity, "pi", ["--mode", "rpc"])).toEqual(["2000", "pi", "--mode", "rpc"]);
    expect(
      ids.command(identity, "pi", ["-x"], { TMPDIR: "/tmp/kobe-pi/pi-1/tmp", HOME: "/h" }),
    ).toEqual(["2000", "/usr/bin/env", "TMPDIR=/tmp/kobe-pi/pi-1/tmp", "pi", "-x"]);
  });

  it("stops and reclaims through the helper, and reports a failed kill-all", async () => {
    const runner = fakeRunner((args) =>
      args[1] === "--kill-all" ? { code: 71, stderr: "kill: boom" } : { code: 0, stderr: "" },
    );
    const ids = new PiIdentities("/helper", [2000], runner.run);
    const identity = { uid: 2000, gid: 2000 };
    await ids.signalGroup(identity, 42, "TERM");
    await ids.removeContents(identity, "/tmp/kobe-pi/pi-1/agent");
    await expect(ids.killAll(identity)).rejects.toThrow(/kill-all as 2000 failed: kill: boom/);
    expect(runner.calls).toEqual([
      ["2000", "/bin/kill", "-s", "TERM", "--", "-42"],
      ["2000", "/usr/bin/find", "/tmp/kobe-pi/pi-1/agent", "-mindepth", "1", "-delete"],
      ["2000", "--kill-all"],
    ]);
    expect(ids.byGid(2000)).toEqual(identity);
    expect(ids.byGid(1000)).toBeUndefined();
  });
});

describe("loading Pi identities", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("takes the identities from the supplementary groups", () => {
    expect(identityUids([1000, 1001, 2000, 2001, 2063, 2064, 4])).toEqual([2000, 2001, 2063]);
  });

  it("accepts only a root-owned helper nobody else can change", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kobe-runas-"));
    const own = path.join(dir, "kobe-runas");
    await writeFile(own, "#!/bin/sh\n", { mode: 0o755 });
    await expect(checkHelperFile(own)).rejects.toThrow(/root-owned/);
    await expect(checkHelperFile("relative/kobe-runas")).rejects.toThrow(/absolute/);
    await expect(checkHelperFile(path.join(dir, "missing"))).rejects.toThrow(PiIdentityError);
    await expect(checkHelperFile("/bin/sh")).resolves.toBeUndefined();
  });

  it("fails closed: too few identities, or a helper that cannot switch", async () => {
    await expect(
      loadPiIdentities("/bin/sh", 8, [2000, 2001], okRunner().run, "/bin/sh"),
    ).rejects.toThrow(/2 Pi identities .* for 8 Pi processes/);
    const broken = fakeRunner(() => ({
      code: 71,
      stderr: "kobe-runas: setgroups: Operation not permitted",
    }));
    await expect(loadPiIdentities("/bin/sh", 1, [2000], broken.run, "/bin/sh")).rejects.toThrow(
      /cannot start processes as a Pi identity.*setgroups/,
    );
    expect(broken.calls).toEqual([["2000", "--probe-ptrace"]]);
    const ids = await loadPiIdentities("/bin/sh", 2, [1000, 2000, 2001], okRunner().run, "/bin/sh");
    expect(ids.size).toBe(2);
  });
});
