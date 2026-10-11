import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EgressWiring } from "./egress/egress-wiring.js";
import type { ModelTokenSource } from "./models/types.js";
import { RUN_2, THREAD, runStart, startHarness, until, type Harness } from "./testing/harness.js";

/**
 * Egress for Pi's tools through the agent (KOBE-39) with the scripted Pi: each Pi gets its own
 * token file in its private runtime directory, BASH_ENV and the proxy coordinates in its env (never
 * the token), rotation rewrites the file, and the file goes with the process.
 */
const TOKEN_1 = "egress.token.one";
const TOKEN_2 = "egress.token.two";
const SCRIPT = "/opt/kobe/egress-env.sh";

function fakeTokens(initial: string): ModelTokenSource & { rotate(token: string): void } {
  let current = initial;
  const listeners = new Set<(token: string) => void>();
  return {
    current: async () => current,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    rotate(token) {
      current = token;
      for (const l of listeners) l(token);
    },
  };
}

let h: Harness;
afterEach(async () => {
  expect(h.server.violations).toEqual([]);
  await h.close();
});

interface Launch {
  readonly env: string[];
  readonly agentDir: string;
  readonly egressTokenFile: string | null;
  readonly bashEnv: string | null;
  readonly toolHome: string | null;
  readonly toolTmp: string | null;
  readonly egressProxy: string | null;
  readonly threadId: string | null;
}

async function start(tokens: ModelTokenSource, message = "hang"): Promise<Launch> {
  const egress: EgressWiring = {
    proxyUrl: "http://egress-proxy.kobe.internal:80",
    noProxy: "server.kobe.internal,localhost",
    envScript: SCRIPT,
    tokens,
  };
  h = await startHarness({ egress });
  const result = await h.server.command(runStart(message));
  expect(result).toMatchObject({ ok: true });
  const [launch] = await h.commandsLog();
  return launch as unknown as Launch;
}

describe("egress for Pi's tools (KOBE-39)", () => {
  it("gives each Pi a private token file and BASH_ENV; the token is in no variable", async () => {
    const launch = await start(fakeTokens(TOKEN_1));
    expect(launch.bashEnv).toBe(SCRIPT);
    expect(launch.egressProxy).toBe("http://egress-proxy.kobe.internal:80");
    expect(launch.threadId).toBe(THREAD);
    expect(launch.env).toEqual(expect.arrayContaining(["NO_PROXY", "no_proxy"]));
    // The pod's credential-less HTTPS_PROXY is not inherited; the script builds it per shell.
    expect(launch.env).not.toContain("HTTPS_PROXY");
    const file = launch.egressTokenFile ?? "";
    expect(path.dirname(file)).toBe(path.dirname(launch.agentDir));
    expect(path.basename(file)).toBe("egress-token");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).toBe(`${TOKEN_1}\n`);
  });

  it("rewrites the file on rotation and removes it with the process", async () => {
    const tokens = fakeTokens(TOKEN_1);
    const launch = await start(tokens);
    const file = launch.egressTokenFile ?? "";
    tokens.rotate(TOKEN_2);
    await until(async () => (await readFile(file, "utf8")) === `${TOKEN_2}\n`);
    await h.agent.stop(500);
    await until(() => !existsSync(file));
  });

  it("stops a Pi whose egress token file was rewritten (tripwire)", async () => {
    const launch = await start(fakeTokens(TOKEN_1), "say:hi");
    await h.server.waitFor((f) => f.type === "pi.event" && f.event.type === "agent_settled");
    await writeFile(launch.egressTokenFile ?? "", "planted.token\n");
    const result = await h.server.command(runStart("say:hi", { run_id: RUN_2 }));
    expect(result).toMatchObject({ ok: false, error: { code: "runtime_tampered" } });
    await until(() => !existsSync(launch.egressTokenFile ?? ""));
  });
});

describe("the tools' HOME and TMPDIR without egress (KOBE-235)", () => {
  async function startPlain(extra: Parameters<typeof startHarness>[0] = {}): Promise<Launch> {
    h = await startHarness(extra);
    expect(await h.server.command(runStart("hang"))).toMatchObject({ ok: true });
    const [launch] = await h.commandsLog();
    return launch as unknown as Launch;
  }

  it("with a tool env script and no egress, Pi still gets BASH_ENV and the shared HOME/TMPDIR names", async () => {
    const launch = await startPlain({ toolEnvScript: SCRIPT });
    expect(launch.bashEnv).toBe(SCRIPT);
    expect(launch.toolHome).toMatch(/\/home$/);
    expect(launch.toolTmp).toBe("/tmp");
    expect(launch.egressTokenFile).toBeNull();
    expect(launch.env).not.toContain("KOBE_EGRESS_PROXY");
  });

  it("without the script (development) nothing is set", async () => {
    const launch = await startPlain();
    expect(launch.bashEnv).toBeNull();
  });

  it("with egress the egress script wins (one BASH_ENV)", async () => {
    const launch = await start(fakeTokens(TOKEN_1));
    expect(launch.bashEnv).toBe(SCRIPT);
    expect(launch.toolHome).toMatch(/\/home$/);
  });
});
