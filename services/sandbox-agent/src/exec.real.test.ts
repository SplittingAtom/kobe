import { spawn, type ChildProcess } from "node:child_process";
import { chmod, chown, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ExecRelay } from "./exec/relay.js";
import { executorEnv, startExecutor } from "./exec/spawn-executor.js";
import { ExecClient } from "./kobe-exec/client.js";
import {
  bashOperations,
  editOperations,
  readOperations,
  writeOperations,
} from "./kobe-exec/remote-ops.js";
import { writeGuardedConfig } from "./models/agent-config.js";
import {
  loadPiIdentities,
  partnerOf,
  type PiIdentities,
  type PiIdentity,
} from "./pi/identities.js";
import { EXECUTOR_BUILT, EXECUTOR_ENTRY } from "./testing/real-pi.js";
import { socketPair } from "./testing/socket-pair.js";
import { prepareToolDir } from "./threads/exec-wiring.js";

/**
 * The tool executor under the REAL helper (KOBE-167): the same relay, client and Pi tool
 * operations the product uses, with the executor started through `kobe-runas` as the partner uid
 * of a Pi identity and the directory layout the agent builds. Same setup and skip rule as
 * identities.real.test.ts (services/sandbox-agent/scripts/test-identities.sh). What the partner
 * uid can and cannot do on its own is identities.partner.real.test.ts; this proves the executor
 * really is that uid, and the properties the tools get from it. Nothing here needs Pi.
 */
const HELPER = process.env.KOBE_TEST_PI_RUNAS;
const WORKSPACE_GID = process.getgid?.() ?? -1;

interface Result {
  readonly code: number | null;
  readonly stdout: string;
}

function asUid(args: readonly string[]): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(HELPER as string, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH },
    });
    let stdout = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

async function alive(pid: number): Promise<boolean> {
  const state = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "gone");
  return !(state === "gone" || / [ZX] /.test(state));
}

describe.runIf(HELPER !== undefined && EXECUTOR_BUILT)(
  "the tool executor under the real helper (KOBE-167)",
  () => {
    let identities: PiIdentities;
    let scratch: string;
    let umask: number;
    const held: PiIdentity[] = [];
    const relays: ExecRelay[] = [];
    const victims: ChildProcess[] = [];

    beforeAll(async () => {
      umask = process.umask(0o077);
      identities = await loadPiIdentities(HELPER as string, 2);
      scratch = await mkdtemp(path.join("/dev/shm", "kobe-exec-"));
      await chmod(scratch, 0o755);
    });
    afterAll(async () => {
      process.umask(umask);
      await rm(scratch, { recursive: true, force: true });
    });
    afterEach(async () => {
      for (const relay of relays.splice(0)) relay.close("test over");
      victims.splice(0);
      for (const identity of held.splice(0)) {
        await identities.killAllPatiently(identity, [10, 10]);
        identities.release(identity);
      }
    });

    /** A Pi identity with the agent's layout, its relay and a client on Pi's end of fd 5. */
    async function setup() {
      const identity = await identities.acquire(1000);
      held.push(identity);
      const root = await mkdtemp(path.join(scratch, "t-"));
      await chmod(root, 0o755);
      const runtime = path.join(root, "pi-x");
      const agentDir = path.join(runtime, "agent");
      const workspace = path.join(root, "workspace");
      const home = path.join(root, "home");
      await mkdir(agentDir, { recursive: true });
      await writeFile(path.join(runtime, "model.json"), '{"run_token":"secret-run-token"}');
      for (const shared of [workspace, home]) {
        await mkdir(shared);
        await chown(shared, -1, WORKSPACE_GID);
        await chmod(shared, 0o2775);
      }
      for (const [file, mode] of [
        [runtime, 0o2750],
        [agentDir, 0o3770],
        [path.join(runtime, "model.json"), 0o640],
      ] as const) {
        await chown(file, -1, identity.gid);
        await chmod(file, mode);
      }
      await writeGuardedConfig(agentDir, true);
      const toolDir = await prepareToolDir(runtime, identity);
      // As the agent's EgressTokenFile does: the mode is set exactly (the umask would strip it).
      await writeFile(path.join(toolDir, "egress-token"), "egress-secret\n");
      await chmod(path.join(toolDir, "egress-token"), 0o640);

      const [extensionEnd, agentEnd] = await socketPair();
      let started = 0;
      const diagnostics: string[] = [];
      const relay = new ExecRelay({
        channel: agentEnd,
        onDiagnostic: (m) => diagnostics.push(m),
        startExecutor: () => {
          started += 1;
          return startExecutor({
            nodeBin: process.execPath,
            entry: EXECUTOR_ENTRY,
            env: executorEnv({ PATH: process.env.PATH ?? "", HOME: home }),
            cwd: workspace,
            runAs: { identities, identity },
            onDiagnostic: (m) => diagnostics.push(m),
          });
        },
      });
      relays.push(relay);
      const client = new ExecClient(extensionEnd);
      extensionEnd.on("error", () => undefined);
      const bash = bashOperations(client);
      const run = async (command: string, cwd = workspace) => {
        let out = "";
        const { exitCode } = await bash.exec(command, cwd, {
          onData: (d) => (out += d.toString()),
        });
        return { exitCode, out };
      };
      return {
        identity,
        partner: partnerOf(identity),
        runtime,
        agentDir,
        toolDir,
        workspace,
        client,
        run,
        started: () => started,
        diagnostics,
      };
    }

    it("runs the executor and every command as the partner uid, in the workspace group only", async () => {
      const t = await setup();
      const { out } = await t.run(
        'echo "uid=$(id -u) gid=$(id -g) groups=$(id -G | tr " " "\\n" | sort -n | paste -sd,)"; ' +
          'echo "parent=$(ps -o uid= -p $PPID | tr -d " ")"; ' +
          'echo "nnp=$(awk "/^NoNewPrivs/{print \\$2}" /proc/self/status)"; echo "umask=$(umask)"',
      );
      const groups = [WORKSPACE_GID, t.partner.gid].sort((a, b) => a - b).join(",");
      expect(out).toContain(`uid=${t.partner.uid} gid=${t.partner.gid} groups=${groups}`);
      // bash's parent is the executor: it runs as the partner too.
      expect(out).toContain(`parent=${t.partner.uid}`);
      expect(out).toContain("nnp=1");
      expect(out).toContain("umask=0002");
      expect(out).not.toContain(String(t.identity.gid));
    }, 60_000);

    it("starts the executor only on the first call, and gives the commands no variable of the agent", async () => {
      process.env.KOBE_AGENT_SECRET_TEST = "must-not-leak";
      try {
        const t = await setup();
        expect(t.started()).toBe(0);
        const { out } = await t.run("env");
        expect(t.started()).toBe(1);
        expect(out).not.toContain("KOBE_AGENT_SECRET_TEST");
        expect(out).toContain("HOME=");
      } finally {
        delete process.env.KOBE_AGENT_SECRET_TEST;
      }
    }, 60_000);

    it("cannot signal Pi, read its memory or environment, or touch its directory", async () => {
      const t = await setup();
      const piProc = spawn(HELPER as string, [String(t.identity.uid), "sleep", "300"], {
        stdio: "ignore",
      });
      victims.push(piProc);
      for (let i = 0; i < 100; i++) {
        const status = await readFile(`/proc/${piProc.pid}/status`, "utf8").catch(() => "");
        if (new RegExp(`^Uid:\\s+${t.identity.uid}\\s`, "m").test(status)) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const attempts: Record<string, string> = {
        kill: `kill -9 ${piProc.pid}`,
        environ: `cat /proc/${piProc.pid}/environ`,
        mem: `head -c1 /proc/${piProc.pid}/mem`,
        plant: `echo x > ${t.agentDir}/models.json`,
        plant2: `rm -f ${t.agentDir}/settings.json && echo x > ${t.agentDir}/settings.json`,
        create: `echo x > ${t.agentDir}/planted`,
        token: `cat ${t.runtime}/model.json`,
        listing: `ls ${t.runtime}`,
        auth: `cat ${t.agentDir}/auth.json`,
      };
      const script = Object.entries(attempts)
        .map(([name, cmd]) => `( ${cmd} ) >/dev/null 2>&1; echo ${name}=$?`)
        .join("\n");
      const { out } = await t.run(script);
      for (const name of Object.keys(attempts))
        expect(out, name).toMatch(new RegExp(`^${name}=[1-9]`, "m"));
      expect(await alive(piProc.pid as number)).toBe(true);
      // Control (same layout): Pi's own uid reads its token file and its environment.
      const control = await asUid([
        String(t.identity.uid),
        "/bin/sh",
        "-c",
        `cat ${t.runtime}/model.json >/dev/null && ls ${t.agentDir} >/dev/null && echo allowed`,
      ]);
      expect(control.stdout.trim()).toBe("allowed");
      expect(await readFile(path.join(t.agentDir, "models.json"), "utf8")).toBe(
        '{"providers":{}}\n',
      );
      // The same attempts through the file tools' operations are refused too.
      const write = writeOperations(t.client);
      await expect(
        write.writeFile(path.join(t.agentDir, "models.json"), "{}"),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/EACCES|EPERM/),
      });
      await expect(
        readOperations(t.client, async () => null).readFile(path.join(t.runtime, "model.json")),
      ).rejects.toMatchObject({ code: expect.stringMatching(/EACCES|EPERM/) });
    }, 90_000);

    it("shares files with Pi through the workspace group, in both directions", async () => {
      const t = await setup();
      await writeOperations(t.client).writeFile(
        path.join(t.workspace, "made-by-tool.txt"),
        "tool\n",
      );
      const info = await stat(path.join(t.workspace, "made-by-tool.txt"));
      expect([info.uid, info.gid, info.mode & 0o777]).toEqual([
        t.partner.uid,
        WORKSPACE_GID,
        0o664,
      ]);
      const pi = await asUid([
        String(t.identity.uid),
        "/bin/sh",
        "-c",
        `cd ${t.workspace} && echo pi >> made-by-tool.txt && echo pi > made-by-pi.txt`,
      ]);
      expect(pi.code).toBe(0);
      // The tool edits what Pi wrote and Pi's file is readable to it.
      await editOperations(t.client).writeFile(
        path.join(t.workspace, "made-by-pi.txt"),
        "edited by the tool\n",
      );
      expect(await readFile(path.join(t.workspace, "made-by-pi.txt"), "utf8")).toBe(
        "edited by the tool\n",
      );
      expect(await readFile(path.join(t.workspace, "made-by-tool.txt"), "utf8")).toBe("tool\npi\n");
    }, 60_000);

    it("hands the egress token to the partner uid and not to Pi (the tool directory)", async () => {
      const t = await setup();
      const fromTool = await t.run(`cat ${t.toolDir}/egress-token`);
      expect(fromTool.out).toBe("egress-secret\n");
      const cannotWrite = await t.run(`echo x > ${t.toolDir}/egress-token; echo $?`);
      expect(cannotWrite.out.trim()).toMatch(/[1-9]$/);
      const fromPi = await asUid([String(t.identity.uid), "/bin/cat", `${t.toolDir}/egress-token`]);
      expect(fromPi.code).not.toBe(0);
      expect(fromPi.stdout).not.toContain("egress-secret");
      expect((await stat(t.toolDir)).gid).toBe(t.partner.gid);
    }, 60_000);

    it("fails the call when the executor is killed, clears what it left, and starts a new one", async () => {
      const t = await setup();
      const marker = path.join(t.workspace, "orphan.pid");
      await expect(
        t.run(`sleep 300 & echo $! > ${marker}; setsid sleep 301 & kill -9 $PPID; sleep 5`),
      ).rejects.toThrow(/tool executor is unavailable/);
      const orphan = Number((await readFile(marker, "utf8")).trim());
      // The next call replaces the executor, and the partner uid is emptied first.
      const next = await t.run("echo again");
      expect(next.out).toBe("again\n");
      expect(t.started()).toBe(2);
      expect(await alive(orphan)).toBe(false);
    }, 90_000);

    it("stops the executor and everything it started with the Pi's identity", async () => {
      const t = await setup();
      const marker = path.join(t.workspace, "bg.pid");
      await t.run(`setsid sleep 300 > /dev/null 2>&1 & echo $! > ${marker}`);
      const bg = Number((await readFile(marker, "utf8")).trim());
      expect(await alive(bg)).toBe(true);
      await identities.killAll(t.identity);
      expect(await alive(bg)).toBe(false);
    }, 60_000);
  },
);
