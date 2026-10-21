import { randomUUID } from "node:crypto";
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
});
