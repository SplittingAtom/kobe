import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createKernelLauncher, kernelEnv } from "./launcher.js";
import { KernelSession } from "./session.js";

const ECHO = fileURLToPath(new URL("./testing/echo-bridge.mjs", import.meta.url));

describe("kernel launcher (NB10)", () => {
  it("gives the kernel the tools' allow-list and nothing else", () => {
    const env = kernelEnv(
      {
        PATH: "/usr/bin",
        TZ: "UTC",
        KOBE_BOOTSTRAP_TOKEN_FILE: "/run/kobe-agent/token",
        KOBE_SANDBOX_TOKEN: "secret",
        HTTPS_PROXY: "http://user:token@proxy",
        NODE_OPTIONS: "--inspect",
      },
      "/home/kobe",
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      TZ: "UTC",
      HOME: "/home/kobe",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONUNBUFFERED: "1",
    });
  });

  it("starts a bridge over stdio in the workspace, and kills its group on stop", async () => {
    const launch = createKernelLauncher({
      python: process.execPath,
      bridge: ECHO,
      workspaceDir: process.cwd(),
      home: "/tmp",
      parentEnv: { PATH: process.env.PATH, SECRET_TOKEN: "x" },
      graceMs: 100,
    });
    const proc = await launch(randomUUID());
    const session = new KernelSession(proc, () => undefined);
    await session.ready(5000);
    const seen: unknown[] = [];
    const result = await session.execute("e1", "env", (o) => seen.push(o));
    expect(result).toEqual({ kind: "done", status: "ok", executionCount: 1 });
    const env = JSON.parse((seen[0] as { text: string }).text) as Record<string, string>;
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.HOME).toBe("/tmp");
    await session.stop("test");
    expect(await proc.exited).toEqual({ code: null, signal: "SIGKILL" });
    expect(session.alive).toBe(false);
  });

  it("gives the kernel egress like the shell tool: a rotating token file, never the token (NB17)", async () => {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "kernel-egress-"));
    let token = "tok.one";
    const listeners: ((t: string) => void)[] = [];
    const launch = createKernelLauncher({
      python: process.execPath,
      bridge: ECHO,
      workspaceDir: process.cwd(),
      home: "/tmp",
      parentEnv: { PATH: process.env.PATH },
      graceMs: 100,
      egress: {
        runtimeRoot,
        wiring: {
          proxyUrl: "http://egress-proxy.kobe.internal:80",
          noProxy: "kobe-server",
          envScript: "/opt/kobe/egress-env.sh",
          tokens: {
            current: () => Promise.resolve(token),
            onChange: (l) => {
              listeners.push(l);
              return () => listeners.splice(listeners.indexOf(l), 1);
            },
          },
        },
      },
    });
    const threadId = randomUUID();
    const proc = await launch(threadId);
    const session = new KernelSession(proc, () => undefined);
    await session.ready(5000);
    const seen: unknown[] = [];
    await session.execute("e1", "env", (o) => seen.push(o));
    const env = JSON.parse((seen[0] as { text: string }).text) as Record<string, string>;
    expect(env).toMatchObject({
      KOBE_EGRESS_PROXY: "http://egress-proxy.kobe.internal:80",
      KOBE_THREAD_ID: threadId,
      NO_PROXY: "kobe-server",
    });
    expect(JSON.stringify(env)).not.toContain("tok.one");
    const file = env.KOBE_EGRESS_TOKEN_FILE ?? "";
    expect(file.startsWith(runtimeRoot)).toBe(true);
    expect(await readFile(file, "utf8")).toBe("tok.one\n");
    token = "tok.two";
    for (const l of listeners) l(token);
    await new Promise((r) => setTimeout(r, 50));
    expect(await readFile(file, "utf8")).toBe("tok.two\n");
    await session.stop("test");
    await expect(stat(path.dirname(file))).rejects.toThrow();
    expect(listeners).toEqual([]);
  });
});
