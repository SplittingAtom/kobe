import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EgressTokenFile, egressEnv, type EgressWiring } from "./egress-wiring.js";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../images/sandbox/egress-env.sh",
);
const THREAD = "9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln-_";

const wiring = (): EgressWiring => ({
  proxyUrl: "http://egress-proxy.kobe.internal:80",
  noProxy: "server.kobe.internal,localhost",
  envScript: SCRIPT,
  tokens: { current: async () => TOKEN, onChange: () => () => undefined },
});

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kobe-egress-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

/**
 * What a Pi bash tool call sees: `bash -c` with Pi's environment only and stdin on /dev/null, as
 * Pi spawns it (bash skips BASH_ENV when stdin is a socket: it then assumes rshd/sshd).
 */
function toolShell(env: Record<string, string>, command: string): string {
  const result = spawnSync("/bin/bash", ["-c", command], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return result.stdout;
}

/** Same, traced (`bash -x`): the token must not show in the trace. */
function tracedShell(env: Record<string, string>, command: string): string {
  const result = spawnSync("/bin/bash", ["-xc", command], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return result.stderr;
}

describe("egress env for Pi's tools", () => {
  it("names the script, the token file, the proxy and the thread; never the token itself", () => {
    const env = egressEnv(wiring(), "/tmp/kobe-pi/pi-x/egress-token", THREAD);
    expect(env).toEqual({
      BASH_ENV: SCRIPT,
      KOBE_EGRESS_TOKEN_FILE: "/tmp/kobe-pi/pi-x/egress-token",
      KOBE_EGRESS_PROXY: "http://egress-proxy.kobe.internal:80",
      KOBE_THREAD_ID: THREAD,
      NO_PROXY: "server.kobe.internal,localhost",
      no_proxy: "server.kobe.internal,localhost",
    });
    expect(JSON.stringify(env)).not.toContain(TOKEN);
    expect(egressEnv(wiring(), "/f", "not-a-uuid").KOBE_THREAD_ID).toBeUndefined();
  });

  it("every bash tool call gets HTTPS_PROXY with the current token, re-read per shell", async () => {
    const file = new EgressTokenFile(path.join(dir, "egress-token"));
    await file.write(TOKEN);
    const env = egressEnv(wiring(), file.path, THREAD);
    const out = toolShell(env, 'printf "%s\\n%s\\n" "$HTTPS_PROXY" "$http_proxy"');
    const url = `http://${THREAD}:${TOKEN}@egress-proxy.kobe.internal:80`;
    expect(out).toBe(`${url}\n${url}\n`);
    // Rotation: the next shell has the new token, without restarting anything.
    await file.write("rotated.token.value");
    expect(toolShell(env, 'printf "%s" "$HTTPS_PROXY"')).toBe(
      `http://${THREAD}:rotated.token.value@egress-proxy.kobe.internal:80`,
    );
    // Child processes inherit it (pip, git, python run from the command).
    expect(toolShell(env, 'sh -c \'printf "%s" "$https_proxy"\'')).toContain("rotated.token.value");
    // A traced shell (`bash -x`, whose output lands in the tool result) never prints the token.
    const trace = tracedShell(env, "true");
    expect(trace).not.toContain("rotated.token.value");
  });

  it("exports nothing for a missing or malformed token file (no shell injection through it)", async () => {
    const tokenFile = path.join(dir, "egress-token");
    const env = egressEnv(wiring(), tokenFile, THREAD);
    expect(toolShell(env, 'printf "[%s]" "${HTTPS_PROXY:-}"')).toBe("[]");
    await writeFile(tokenFile, "abc$(touch pwned)@evil:1\n");
    expect(toolShell(env, 'printf "[%s]" "${HTTPS_PROXY:-}"')).toBe("[]");
    expect(await readdir(dir)).toEqual(["egress-token"]);
  });

  it("writes the token file 0600, atomically, refusing non-JWT characters and planted symlinks", async () => {
    const file = new EgressTokenFile(path.join(dir, "egress-token"));
    await expect(file.write("bad token")).rejects.toThrow(/unexpected characters/);
    await file.write(TOKEN);
    expect((await stat(file.path)).mode & 0o777).toBe(0o600);
    expect(await file.holds(TOKEN)).toBe(true);
    // A symlink at the final path is replaced by the rename, never followed.
    const target = path.join(dir, "elsewhere");
    await writeFile(target, "untouched");
    await rm(file.path);
    await symlink(target, file.path);
    await file.write("next.token");
    expect(await file.holds("next.token")).toBe(true);
    await expect(readFile(target, "utf8")).resolves.toBe("untouched");
    expect((await readdir(dir)).sort()).toEqual(["egress-token", "elsewhere"]);
  });
});
