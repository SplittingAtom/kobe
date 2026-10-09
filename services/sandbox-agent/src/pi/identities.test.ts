import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PiIdentities,
  PiIdentityError,
  RECLAIM_TIMEOUT_MS,
  checkHelperFile,
  PARTNER_UID_MAX,
  PARTNER_UID_MIN,
  PI_UID_MAX,
  PI_UID_MIN,
  identityUids,
  loadPiIdentities,
  pairedUids,
  partnerOf,
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

  it("gives a slow reclaim its own timeout and retries it (real process runner)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kobe-reclaim-"));
    try {
      // A "helper" whose first run hangs (a huge workspace), the next finishes.
      const helper = path.join(dir, "slow-helper");
      const marker = path.join(dir, "ran-once");
      await writeFile(
        helper,
        `#!/bin/sh\nif [ -e ${marker} ]; then exit 0; fi\n: > ${marker}\nexec sleep 30\n`,
        { mode: 0o755 },
      );
      const ids = new PiIdentities(helper, [2000], undefined, "/reclaim");
      const started = Date.now();
      await ids.reclaimFiles({ uid: 2000, gid: 2000 }, 1000, ["/w"], {
        timeoutMs: 300,
        delaysMs: [10],
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(300);
      // Every attempt times out: the identity is given up with a clear reason.
      await rm(marker);
      const hung = path.join(dir, "always-slow");
      await writeFile(hung, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
      const stuck = new PiIdentities(hung, [2000], undefined, "/reclaim");
      await expect(
        stuck.reclaimFiles({ uid: 2000, gid: 2000 }, 1000, ["/w"], {
          timeoutMs: 100,
          delaysMs: [10],
        }),
      ).rejects.toThrow(/reclaim as 2000 failed \(timed out\)/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs the reclaim with its long timeout, not the helper's default", async () => {
    const seen: (number | undefined)[] = [];
    const ids = new PiIdentities(
      "/helper",
      [2000],
      async (_helper, _args, timeoutMs) => {
        seen.push(timeoutMs);
        return { code: 0, stderr: "" };
      },
      "/opt/kobe/bin/kobe-reclaim",
    );
    await ids.reclaimFiles({ uid: 2000, gid: 2000 }, 1000, ["/workspace", "/tmp"]);
    expect(seen).toEqual([RECLAIM_TIMEOUT_MS]);
    expect(RECLAIM_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("passes the purge dirs after `--`, and gives the identity up when the reclaim keeps failing", async () => {
    const runner = fakeRunner(() => ({
      code: 70,
      stderr: "kobe-reclaim: could not reclaim: /w/x",
    }));
    const ids = new PiIdentities("/helper", [2000], runner.run, "/opt/kobe/bin/kobe-reclaim");
    await expect(
      ids.reclaimFiles({ uid: 2000, gid: 2000 }, 1000, ["/workspace", "/tmp"], {
        delaysMs: [1],
        purgeDirs: ["/run/kobe-pi"],
      }),
    ).rejects.toThrow(/reclaim as 2000 failed: kobe-reclaim: could not reclaim/);
    const args = [
      "2000",
      "/opt/kobe/bin/kobe-reclaim",
      "1000",
      "/workspace",
      "/tmp",
      "--",
      "/run/kobe-pi",
    ];
    expect(runner.calls).toEqual([args, args]);
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

describe("paired partner (tool) uids (KOBE-166)", () => {
  const pi = { uid: 2001, gid: 2001 };
  const partner = { uid: 3001, gid: 3001 };

  it("pairs every Pi uid with a distinct partner uid in a second range, same number", () => {
    expect([PARTNER_UID_MIN, PARTNER_UID_MAX]).toEqual([3000, 3063]);
    const partners = new Set<number>();
    for (let uid = PI_UID_MIN; uid <= PI_UID_MAX; uid++) {
      const p = partnerOf({ uid, gid: uid });
      expect(p.gid).toBe(p.uid);
      expect(p.uid).toBe(uid + 1000);
      expect(p.uid).toBeGreaterThanOrEqual(PARTNER_UID_MIN);
      expect(p.uid).toBeLessThanOrEqual(PARTNER_UID_MAX);
      partners.add(p.uid);
    }
    expect(partners.size).toBe(PI_UID_MAX - PI_UID_MIN + 1);
  });

  it("is in force only when the agent holds every partner group", () => {
    expect(pairedUids([2000, 2001], [1001, 2000, 2001, 3000, 3001])).toBe(true);
    expect(pairedUids([2000, 2001], [1001, 2000, 2001, 3000])).toBe(false);
    expect(pairedUids([2000, 2001], [1001, 2000, 2001])).toBe(false);
    expect(pairedUids([], [3000])).toBe(false);
    // The partner groups are not Pi identities.
    expect(identityUids([2000, 3000, 3063])).toEqual([2000]);
  });

  it("kills both uids of a pair, every one even if the first fails", async () => {
    const runner = fakeRunner((args) =>
      args[0] === "2001" ? { code: 71, stderr: "boom" } : { code: 0, stderr: "" },
    );
    const ids = new PiIdentities("/helper", [2001], runner.run, "/reclaim", true);
    await expect(ids.killAll(pi)).rejects.toThrow(/kill-all as 2001 failed: boom/);
    expect(runner.calls).toEqual([
      ["2001", "--kill-all"],
      ["3001", "--kill-all"],
    ]);
    const bad = fakeRunner((args) =>
      args[0] === "3001" ? { code: 71, stderr: "partner busy" } : { code: 0, stderr: "" },
    );
    const second = new PiIdentities("/helper", [2001], bad.run, "/reclaim", true);
    await expect(second.killAll(pi)).rejects.toThrow(/kill-all as 3001 failed: partner busy/);
  });

  it("leaves the partner alone without pairs", async () => {
    const runner = okRunner();
    const ids = new PiIdentities("/helper", [2001], runner.run);
    await ids.killAll(pi);
    await ids.reclaimFiles(pi, 1000, ["/w"], { delaysMs: [] });
    expect(runner.calls.map((c) => c[0])).toEqual(["2001", "2001"]);
  });

  it("reclaims the files of both uids, and gives the identity up if either fails", async () => {
    const runner = okRunner();
    const ids = new PiIdentities("/helper", [2001], runner.run, "/reclaim", true);
    await ids.reclaimFiles(pi, 1000, ["/w"], { purgeDirs: ["/rt"], delaysMs: [] });
    expect(runner.calls).toEqual([
      ["2001", "/reclaim", "1000", "/w", "--", "/rt"],
      ["3001", "/reclaim", "1000", "/w", "--", "/rt"],
    ]);
    const failing = fakeRunner((args) =>
      args[0] === "3001" ? { code: 70, stderr: "left x" } : { code: 0, stderr: "" },
    );
    const broken = new PiIdentities("/helper", [2001], failing.run, "/reclaim", true);
    await expect(broken.reclaimFiles(pi, 1000, ["/w"], { delaysMs: [] })).rejects.toThrow(
      /reclaim as 3001 failed: left x/,
    );
  });

  it("wraps a command for the partner uid", () => {
    const ids = new PiIdentities("/helper", [2001], okRunner().run, "/reclaim", true);
    expect(ids.partnerCommand(pi, "executor", ["-x"])).toEqual(["3001", "executor", "-x"]);
    expect(ids.partnerCommand(pi, "executor", [], { TMPDIR: "/t" })).toEqual([
      "3001",
      "/usr/bin/env",
      "TMPDIR=/t",
      "executor",
    ]);
    expect(partnerOf(pi)).toEqual(partner);
  });

  it("probes a partner switch at start-up when paired, and fails closed if it cannot", async () => {
    const ok = okRunner();
    const ids = await loadPiIdentities("/bin/sh", 1, [2000, 3000], ok.run, "/bin/sh");
    expect(ids.paired).toBe(true);
    expect(ok.calls).toEqual([
      ["2000", "--probe-ptrace"],
      ["3000", "--probe-ptrace"],
    ]);
    const noPartner = fakeRunner((args) =>
      args[0] === "3000"
        ? { code: 77, stderr: "kobe-runas: uid refused" }
        : { code: 0, stderr: "" },
    );
    await expect(
      loadPiIdentities("/bin/sh", 1, [2000, 3000], noPartner.run, "/bin/sh"),
    ).rejects.toThrow(/partner \(tool\) identity.*uid refused/);
    const old = okRunner();
    const unpaired = await loadPiIdentities("/bin/sh", 1, [2000], old.run, "/bin/sh");
    expect(unpaired.paired).toBe(false);
    expect(old.calls).toEqual([["2000", "--probe-ptrace"]]);
  });
});
