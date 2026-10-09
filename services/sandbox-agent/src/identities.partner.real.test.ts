import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmod, chown, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  loadPiIdentities,
  partnerOf,
  PARTNER_UID_MAX,
  PARTNER_UID_MIN,
  type PiIdentities,
  type PiIdentity,
} from "./pi/identities.js";

/**
 * Paired partner (tool) uids with the real helper (KOBE-166). Same setup and skip rule as
 * identities.real.test.ts (services/sandbox-agent/scripts/test-identities.sh, which also gives
 * this process the partner groups 3000-3003). Nothing here goes through the agent: the executor
 * that will run as a partner uid is KOBE-167, so these tests start processes with the helper the
 * way the agent will, and check what the uids can and cannot do to each other.
 */
const HELPER = process.env.KOBE_TEST_PI_RUNAS;
const WORKSPACE_GID = process.getgid?.() ?? -1;

interface Result {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** `kobe-runas <args>` to completion; `stdio` extras are passed as fds 3.. (default none). */
function helper(args: readonly string[], extraFds = 0): Promise<Result> {
  return new Promise((resolve) => {
    const stdio: ("ignore" | "pipe")[] = ["ignore", "pipe", "pipe"];
    // Sockets, not "ignore": Node leaves ignored fds above 2 closed.
    for (let i = 0; i < extraFds; i++) stdio.push("pipe");
    const child = spawn(HELPER as string, [...args], { stdio, env: { PATH: process.env.PATH } });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** A long-lived process of `uid` (the helper execs, so the pid is the program's). */
async function victim(uid: number): Promise<ChildProcess & { pid: number }> {
  const child = spawn(HELPER as string, [String(uid), "sleep", "300"], { stdio: "ignore" });
  // Alive and exec'd as the target once its /proc entry shows the uid.
  for (let i = 0; i < 100; i++) {
    const status = await readFile(`/proc/${child.pid}/status`, "utf8").catch(() => "");
    if (new RegExp(`^Uid:\\s+${uid}\\s`, "m").test(status) && /^Name:\s+sleep$/m.test(status))
      break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return child as ChildProcess & { pid: number };
}

async function isGone(pid: number): Promise<boolean> {
  const state = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "gone");
  return state === "gone" || / [ZX] /.test(state);
}

const HAS_PYTHON = spawnSync("python3", ["--version"]).status === 0;

describe.runIf(HELPER !== undefined)("paired partner uids with the real helper (KOBE-166)", () => {
  let identities: PiIdentities;
  let scratch: string;
  const held: PiIdentity[] = [];
  const victims: ChildProcess[] = [];
  let umask: number;

  beforeAll(async () => {
    umask = process.umask(0o077);
    identities = await loadPiIdentities(HELPER as string, 2);
    scratch = await mkdtemp(path.join("/dev/shm", "kobe-partner-"));
    await chmod(scratch, 0o755);
  });
  afterAll(async () => {
    process.umask(umask);
    await rm(scratch, { recursive: true, force: true });
  });
  afterEach(async () => {
    // The victims belong to uids of held identities: the kill-all below ends them (this process
    // cannot signal another uid).
    victims.splice(0);
    for (const identity of held.splice(0)) {
      await identities.killAllPatiently(identity, [10, 10]);
      identities.release(identity);
    }
  });

  async function acquire(): Promise<PiIdentity> {
    const identity = await identities.acquire(1000);
    held.push(identity);
    return identity;
  }

  async function track(uid: number): Promise<ChildProcess & { pid: number }> {
    const child = await victim(uid);
    victims.push(child);
    return child;
  }

  it("is in force because the agent holds the partner groups (as the pod spec gives them)", () => {
    expect(identities.paired).toBe(true);
  });

  it("gives every Pi identity a distinct partner uid from the second range", async () => {
    const pairs: [PiIdentity, PiIdentity][] = [];
    for (let i = 0; i < identities.size; i++) {
      const pi = await acquire();
      pairs.push([pi, partnerOf(pi)]);
    }
    const partners = pairs.map(([, partner]) => partner.uid);
    expect(new Set(partners).size).toBe(identities.size);
    const piUids = new Set(pairs.map(([pi]) => pi.uid));
    for (const [pi, partner] of pairs) {
      expect(partner.uid).toBeGreaterThanOrEqual(PARTNER_UID_MIN);
      expect(partner.uid).toBeLessThanOrEqual(PARTNER_UID_MAX);
      expect(partner.uid).toBe(pi.uid + 1000);
      expect(piUids.has(partner.uid)).toBe(false);
    }
  });

  it("starts a partner process under its own uid, workspace group only, no capabilities, umask 002", async () => {
    const pi = await acquire();
    const partner = partnerOf(pi);
    const script =
      'echo "uid=$(id -u) gid=$(id -g) groups=$(id -G | tr " " "\\n" | sort -n | paste -sd,)' +
      ' caps=$(awk "/^CapPrm/{p=\\$2} /^CapEff/{e=\\$2} END{print p \\"/\\" e}" /proc/self/status)' +
      ' nnp=$(awk "/^NoNewPrivs/{print \\$2}" /proc/self/status) umask=$(umask)"';
    const [asPartner, asPi] = await Promise.all([
      helper(identities.partnerCommand(pi, "/bin/sh", ["-c", script]) as string[]),
      helper(identities.command(pi, "/bin/sh", ["-c", script]) as string[]),
    ]);
    const groups = [WORKSPACE_GID, partner.gid].sort((a, b) => a - b).join(",");
    const zero = "0000000000000000/0000000000000000";
    expect(asPartner.stdout.trim()).toBe(
      `uid=${partner.uid} gid=${partner.gid} groups=${groups} caps=${zero} nnp=1 umask=0002`,
    );
    // The partner is in none of the Pi's groups, and the Pi in none of the partner's.
    expect(asPartner.stdout).not.toContain(String(pi.gid));
    expect(asPi.stdout).not.toContain(String(partner.gid));
  });

  it("hands a partner uid stdio only; Pi keeps fd 3, 4 and 5", async () => {
    const pi = await acquire();
    const probe =
      'for n in 3 4 5 6; do [ -e /proc/self/fd/$n ] && printf "open$n " || printf "closed$n "; done';
    const partner = await helper(
      identities.partnerCommand(pi, "/bin/sh", ["-c", probe]) as string[],
      4,
    );
    expect(partner.stdout.trim()).toBe("closed3 closed4 closed5 closed6");
    const own = await helper(identities.command(pi, "/bin/sh", ["-c", probe]) as string[], 4);
    expect(own.stdout.trim()).toBe("open3 open4 open5 closed6");
  });

  it("refuses uids outside the two ranges", async () => {
    for (const uid of [0, 1000, 1999, 2064, 2999, 3064]) {
      expect((await helper([String(uid), "id"])).code).toBe(64);
    }
  });

  it("a partner cannot signal, read or ptrace its Pi, nor the reverse", async () => {
    const pi = await acquire();
    const partner = partnerOf(pi);
    const piProc = await track(pi.uid);
    const toolProc = await track(partner.uid);
    const attempt = (target: number) =>
      [
        `kill -0 ${target}; echo kill=$?`,
        `kill -9 ${target}; echo kill9=$?`,
        `cat /proc/${target}/environ >/dev/null; echo environ=$?`,
        `head -c1 /proc/${target}/mem >/dev/null; echo mem=$?`,
      ].join("; ");
    const fromPartner = await helper(
      identities.partnerCommand(pi, "/bin/sh", ["-c", attempt(piProc.pid)]) as string[],
    );
    expect(fromPartner.stdout).toMatch(/kill=1/);
    expect(fromPartner.stdout).toMatch(/kill9=1/);
    expect(fromPartner.stdout).toMatch(/environ=1/);
    expect(fromPartner.stdout).toMatch(/mem=1/);
    const fromPi = await helper(
      identities.command(pi, "/bin/sh", ["-c", attempt(toolProc.pid)]) as string[],
    );
    expect(fromPi.stdout).toMatch(/kill=1/);
    expect(fromPi.stdout).toMatch(/kill9=1/);
    expect(await isGone(piProc.pid)).toBe(false);
    expect(await isGone(toolProc.pid)).toBe(false);
  });

  it.runIf(HAS_PYTHON)("a partner cannot ptrace-attach to its Pi", async () => {
    const pi = await acquire();
    const piProc = await track(pi.uid);
    const code =
      "import ctypes,sys;l=ctypes.CDLL(None,use_errno=True);" +
      "print(l.ptrace(16,int(sys.argv[1]),0,0),ctypes.get_errno())";
    const out = await helper(
      identities.partnerCommand(pi, "python3", ["-c", code, String(piProc.pid)]) as string[],
    );
    expect(out.stdout.trim()).toBe("-1 1"); // PTRACE_ATTACH: EPERM
  });

  it("a partner cannot write, replace or read in its Pi's runtime directory (agent/, model.json)", async () => {
    const pi = await acquire();
    // The layout the agent builds (KOBE-71): the agent owns the directory, the Pi's group
    // reads it; only agent/ is group-writable.
    const dir = path.join(scratch, "runtime");
    await mkdir(path.join(dir, "agent"), { recursive: true });
    await writeFile(path.join(dir, "model.json"), "{}", { mode: 0o640 });
    await writeFile(path.join(dir, "agent", "models.json"), "{}", { mode: 0o660 });
    for (const [file, mode] of [
      [dir, 0o2750],
      [path.join(dir, "agent"), 0o2770],
      [path.join(dir, "model.json"), 0o640],
      [path.join(dir, "agent", "models.json"), 0o660],
    ] as const) {
      await chown(file, process.getuid?.() ?? 0, pi.gid);
      await chmod(file, mode);
    }
    const tryAll = [
      `echo x > ${dir}/agent/planted; echo create=$?`,
      `echo x > ${dir}/agent/models.json; echo overwrite=$?`,
      `mv ${dir}/agent/models.json ${dir}/agent/models.json.x; echo rename=$?`,
      `rm -f ${dir}/agent/models.json; echo remove=$?`,
      `cat ${dir}/model.json; echo read=$?`,
      `ls ${dir}/agent; echo list=$?`,
    ].join("\n");
    const out = await helper(identities.partnerCommand(pi, "/bin/sh", ["-c", tryAll]) as string[]);
    for (const name of ["create", "overwrite", "rename", "remove", "read", "list"]) {
      expect(out.stdout, name).toMatch(new RegExp(`${name}=[1-9]`));
    }
    await expect(stat(path.join(dir, "agent", "planted"))).rejects.toThrow();
    expect(await readFile(path.join(dir, "agent", "models.json"), "utf8")).toBe("{}");
    // Control: the Pi's own uid can write agent/ (the test layout is the real one).
    const control = await helper(
      identities.command(pi, "/bin/sh", [
        "-c",
        `echo x > ${dir}/agent/planted; echo $?`,
      ]) as string[],
    );
    expect(control.stdout.trim()).toBe("0");
  });

  it("shares the workspace between the two uids of a pair", async () => {
    const pi = await acquire();
    const work = path.join(scratch, "workspace");
    await mkdir(work);
    await chown(work, process.getuid?.() ?? 0, WORKSPACE_GID);
    await chmod(work, 0o2775);
    await helper(
      identities.partnerCommand(pi, "/bin/sh", [
        "-c",
        `cd ${work} && echo tool > f && mkdir d && echo tool > d/g`,
      ]) as string[],
    );
    const info = await stat(path.join(work, "f"));
    expect(info.uid).toBe(partnerOf(pi).uid);
    expect(info.gid).toBe(WORKSPACE_GID);
    expect(info.mode & 0o777).toBe(0o664);
    const piWrite = await helper(
      identities.command(pi, "/bin/sh", [
        "-c",
        `cd ${work} && echo pi >> f && echo pi >> d/g && echo pi > h`,
      ]) as string[],
    );
    expect(piWrite.code).toBe(0);
    expect(await readFile(path.join(work, "f"), "utf8")).toBe("tool\npi\n");
  });

  it("reclaims both uids before the pair is reused: processes killed, owner-only files handed to the workspace group", async () => {
    const pi = await acquire();
    const partner = partnerOf(pi);
    const work = path.join(scratch, "reclaim");
    await mkdir(work);
    await chown(work, process.getuid?.() ?? 0, WORKSPACE_GID);
    await chmod(work, 0o2775);
    const piProc = await track(pi.uid);
    const toolProc = await track(partner.uid);
    // A double-forked escapee of the partner, and owner-only files two directories deep.
    await helper(
      identities.partnerCommand(pi, "/bin/sh", [
        "-c",
        `umask 077; (setsid sleep 300 >/dev/null 2>&1 </dev/null &); mkdir -p ${work}/d/e; echo s > ${work}/d/e/f; echo s > ${work}/g; chmod 000 ${work}/d/e ${work}/d`,
      ]) as string[],
    );
    await identities.killAllPatiently(pi, [10]);
    await identities.reclaimFiles(pi, WORKSPACE_GID, [work], { delaysMs: [] });
    expect(await isGone(piProc.pid)).toBe(true);
    expect(await isGone(toolProc.pid)).toBe(true);
    const left = spawnSync("ps", ["-eo", "uid=,stat="], { encoding: "utf8" })
      .stdout.split("\n")
      .filter((line) => Number(line.trim().split(/\s+/)[0]) === partner.uid && !/\sZ/.test(line));
    expect(left).toEqual([]);
    for (const rel of ["d", "d/e"]) {
      const info = await stat(path.join(work, rel));
      expect(info.uid).toBe(partner.uid);
      expect(info.gid).toBe(WORKSPACE_GID);
      expect(info.mode & 0o070).toBe(0o070);
    }
    for (const rel of ["d/e/f", "g"]) {
      const file = path.join(work, rel);
      expect((await stat(file)).mode & 0o060).toBe(0o060);
      expect(await readFile(file, "utf8")).toBe("s\n");
    }
    // Only now may the identity (and so its partner uid) go to another thread.
    held.splice(held.indexOf(pi), 1);
    identities.release(pi);
    const uids: number[] = [];
    for (let i = 0; i < identities.size; i++) uids.push((await acquire()).uid);
    expect(uids).toContain(pi.uid);
  });
});
