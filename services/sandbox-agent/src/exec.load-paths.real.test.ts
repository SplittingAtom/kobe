import { spawn } from "node:child_process";
import { chmod, chown, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalGateway, type LocalGateway } from "@kobe/model-gateway/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  loadPiIdentities,
  partnerOf,
  type PiIdentities,
  type PiIdentity,
} from "./pi/identities.js";
import { PiRpc, type PiPair } from "./testing/real-pi-rpc.js";
import {
  EXECUTOR_BUILT,
  EXECUTOR_ENTRY,
  PI_AVAILABLE,
  PI_BIN,
  REAL_EXEC_EXTENSION,
  REAL_POLICY_EXTENSION,
} from "./testing/real-pi.js";

/**
 * KOBE-196 (review of KOBE-167): nothing Pi reads or loads code from may be writable by the
 * partner uid. Pi loads extensions through jiti, which trusts a transpile cache in `$TMPDIR/jiti`,
 * and Node falls back to `$HOME/.node_modules` for optional modules the bundled provider SDKs
 * require. With a shared TMPDIR and HOME (and `kobe-reclaim` handing a finished Pi's files to the
 * workspace group) a tool plants code there and the next Pi runs it. Real helper, real Pi: the
 * control shows the plant works against the old layout; the hardened layout (private HOME and
 * TMPDIR, caches off) does not run it, for the current Pi and for the next one.
 */
const HELPER = process.env.KOBE_TEST_PI_RUNAS;
const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_EXTENSION = path.join(
  PACKAGE,
  process.env.CI === undefined ? "src/kobe-models/index.ts" : "dist/kobe-models/index.js",
);

function run(args: readonly string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(HELPER as string, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH },
    });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", (code) => resolve({ code, out }));
  });
}

describe.runIf(PI_AVAILABLE && EXECUTOR_BUILT && HELPER !== undefined)(
  "tools cannot plant code that Pi loads (KOBE-196)",
  () => {
    let identities: PiIdentities;
    let identity: PiIdentity;
    let gateway: LocalGateway | undefined;
    let scratch: string;
    let umask: number;
    const open: PiRpc[] = [];
    const wsGid = process.getgid?.() ?? 0;

    beforeAll(async () => {
      umask = process.umask(0o007);
      identities = await loadPiIdentities(HELPER as string, 1);
      identity = await identities.acquire(1000);
      scratch = await mkdtemp(path.join("/dev/shm", "kobe-load-"));
      await chmod(scratch, 0o755);
    });
    afterAll(async () => {
      process.umask(umask);
      await identities.killAllPatiently(identity, [10, 10]).catch(() => undefined);
      identities.release(identity);
      await rm(scratch, { recursive: true, force: true });
    });
    afterEach(async () => {
      for (const rpc of open.splice(0)) await rpc.close();
      await gateway?.close();
      gateway = undefined;
    });

    async function sharedDir(name: string): Promise<string> {
      const dir = path.join(scratch, name);
      await mkdir(dir);
      await chown(dir, -1, wsGid);
      await chmod(dir, 0o2775);
      return dir;
    }

    async function startPi(hardened: boolean, sharedTmp: string): Promise<PiRpc> {
      gateway ??= await startLocalGateway({ enabledModels: [] });
      const pair: PiPair = { identities, identity, workspaceGid: wsGid, hardened, sharedTmp };
      const rpc = await PiRpc.start(
        {
          piBin: PI_BIN,
          modelsExtension: MODELS_EXTENSION,
          policyExtension: REAL_POLICY_EXTENSION,
          gatewayUrl: gateway.url,
          exec: { extension: REAL_EXEC_EXTENSION, executorEntry: EXECUTOR_ENTRY, pair },
        },
        gateway.mintToken(),
      );
      open.push(rpc);
      return rpc;
    }

    const asTool = (script: string) =>
      run(identities.partnerCommand(identity, "/bin/sh", ["-c", script]) as string[]);
    const asPi = (script: string) =>
      run(identities.command(identity, "/bin/sh", ["-c", script]) as string[]);

    const payload = (canary: string) =>
      `process.getBuiltinModule("fs").writeFileSync(${JSON.stringify(canary)}, "pwned");`;

    /** Every jiti cache entry in `tmp/jiti` gets the payload prepended, by the partner uid. */
    const plantJiti = (tmp: string, canary: string) =>
      asTool(
        `for f in ${tmp}/jiti/*.mjs; do { printf '%s\\n' '${payload(canary)}'; cat "$f"; } > "$f.n" && cat "$f.n" > "$f" && rm -f "$f.n" || echo "denied $f"; done`,
      );

    it("control: a shared TMPDIR whose jiti cache the old reclaim opened to the group runs the planted code in the next Pi", async () => {
      const tmp = await sharedDir("tmp-old");
      const canary = path.join(await sharedDir("c1"), "canary");
      const first = await startPi(false, tmp);
      expect(existsSync(path.join(tmp, "jiti"))).toBe(true);
      await first.close();
      open.splice(0);
      // What kobe-reclaim used to do to a finished Pi's files in /tmp.
      await asPi(`chgrp -R ${wsGid} ${tmp}/jiti && chmod -R g+rwX ${tmp}/jiti`);
      expect((await plantJiti(tmp, canary)).out).not.toContain("denied");
      await startPi(false, tmp);
      expect(existsSync(canary)).toBe(true);
    }, 180_000);

    it("hardened: the cache is off, Pi's TMPDIR is not writable by the partner uid, and nothing planted in the shared one runs", async () => {
      const tmp = await sharedDir("tmp-new");
      const canary = path.join(await sharedDir("c2"), "canary");
      const first = await startPi(true, tmp);
      // No jiti cache anywhere: not in Pi's own TMPDIR, not in the shared one.
      expect(existsSync(path.join(first.piTmp, "jiti"))).toBe(false);
      expect(existsSync(path.join(tmp, "jiti"))).toBe(false);
      // The partner uid cannot write, create in or replace Pi's TMPDIR or HOME.
      const probe = await asTool(
        `for d in ${first.piTmp} ${first.piHome}; do mkdir $d/jiti 2>/dev/null && echo "wrote $d"; echo x > $d/f 2>/dev/null && echo "wrote $d"; done; echo done`,
      );
      expect(probe.out).not.toContain("wrote");
      expect(probe.out.trim().endsWith("done")).toBe(true);
      expect((await stat(first.piTmp)).gid).toBe(identity.gid);
      // The tool plants wherever it can: shared TMPDIR/HOME (and a fake jiti dir there).
      await asTool(
        `mkdir -p ${tmp}/jiti && echo '${payload(canary)}' > ${tmp}/jiti/kobe-exec-index.deadbeef.mjs`,
      );
      await first.close();
      open.splice(0);
      await startPi(true, tmp);
      expect(existsSync(canary)).toBe(false);
    }, 180_000);

    it("kobe-reclaim deletes the jiti and compile caches of a finished Pi instead of opening them to the group", async () => {
      const tmp = await sharedDir("tmp-reclaim");
      await asPi(
        `mkdir -p ${tmp}/jiti ${tmp}/node-compile-cache && echo x > ${tmp}/jiti/a.mjs && echo y > ${tmp}/other`,
      );
      await identities.reclaimFiles(identity, wsGid, [tmp], { delaysMs: [] });
      expect(existsSync(path.join(tmp, "jiti"))).toBe(false);
      expect(existsSync(path.join(tmp, "node-compile-cache"))).toBe(false);
      // The rest is reclaimed as before (the workspace group's).
      expect((await stat(path.join(tmp, "other"))).gid).toBe(wsGid);
    }, 60_000);

    it("Node's $HOME/.node_modules fallback: a package planted in the shared HOME loads for a Pi with that HOME (control), not with its private HOME", async () => {
      const home = await sharedDir("home");
      const canaryOld = path.join(await sharedDir("c3"), "canary");
      const canaryNew = path.join(await sharedDir("c4"), "canary");
      const planted = async (canary: string) => {
        await asTool(
          `mkdir -p ${home}/.node_modules/bufferutil && echo '${payload(canary)}' > ${home}/.node_modules/bufferutil/index.js`,
        );
      };
      const tryRequire = (h: string) =>
        run(
          identities.command(identity, "/usr/bin/env", [
            `HOME=${h}`,
            process.execPath,
            "-e",
            'try { require("bufferutil"); } catch {}',
          ]) as string[],
        );
      await planted(canaryOld);
      await tryRequire(home);
      expect(existsSync(canaryOld)).toBe(true);
      // The layout Pi gets now: a private HOME beside the runtime dir.
      const hardened = await startPi(true, await sharedDir("tmp-home"));
      await planted(canaryNew);
      await tryRequire(hardened.piHome);
      expect(existsSync(canaryNew)).toBe(false);
      expect(partnerOf(identity).uid).toBeGreaterThan(0);
      expect((await readFile(canaryOld, "utf8")).length).toBeGreaterThan(0);
    }, 120_000);
  },
);
