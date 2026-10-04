import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { ModelTokenSource } from "../models/types.js";

/**
 * Egress for the tools Pi runs (KOBE-39; KOBE-38's open question 2). Pi's environment is built from
 * an allow-list, so the pod's `HTTPS_PROXY` (no credentials: none exist when the pod starts) never
 * reaches tools, and the egress token must not sit in a pod spec, an argv or a log. Instead:
 *
 * - the agent keeps the sandbox's rotating `kobe.egress-proxy` token in a file in each Pi
 *   process's private runtime directory (0600, temp file + rename; the same per-process pattern
 *   as KOBE-41's model file), rewritten on every rotation;
 * - Pi gets `BASH_ENV=<root-owned script>` plus the file's path, the proxy URL (no credentials)
 *   and the thread id. Pi runs every bash tool call as non-interactive `/bin/bash -c`, which
 *   sources `BASH_ENV` first: the script reads the token with the `read` builtin (no process, no
 *   argv) and exports `HTTPS_PROXY=http://<thread id>:<token>@egress-proxy…` (and the lowercase
 *   and HTTP variants), so curl, pip, npm, git and Python in that command use the proxy with a
 *   fresh token. The thread id is the proxy's hint to attribute a blocked request to this thread.
 *
 * Same-uid limits (as KOBE-41): any process of the sandbox user can read the token (it is the
 * sandbox's own, short-lived, D30) or rewrite the file (it only changes its own shells' proxy).
 * Long-running processes keep the token they started with and need a new shell after ~15 min.
 */
export interface EgressWiring {
  /** `KOBE_EGRESS_PROXY_URL`: `http://host:port`, no credentials. */
  readonly proxyUrl: string;
  /** Hosts tools reach directly (the pod's `NO_PROXY`). */
  readonly noProxy: string;
  /** The root-owned BASH_ENV script (`/opt/kobe/egress-env.sh`). */
  readonly envScript: string;
  readonly tokens: ModelTokenSource;
}

export const EGRESS_TOKEN_FILE_NAME = "egress-token";
export const EGRESS_TOKEN_FILE_ENV = "KOBE_EGRESS_TOKEN_FILE";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** JWT characters only: the script refuses anything else, so the file can't inject shell. */
const TOKEN = /^[A-Za-z0-9._-]+$/;

/** A temp file of the token writer (`egress-token.<hex>.tmp`). */
export function isEgressTemp(name: string): boolean {
  return /^egress-token\.[0-9a-f]{16}\.tmp$/.test(name);
}

/** The variables Pi (and so every bash tool call) gets for egress; no secret among them. */
export function egressEnv(
  wiring: EgressWiring,
  tokenFile: string,
  threadId: string,
): Record<string, string> {
  return {
    BASH_ENV: wiring.envScript,
    [EGRESS_TOKEN_FILE_ENV]: tokenFile,
    KOBE_EGRESS_PROXY: wiring.proxyUrl,
    // Only a UUID: it becomes the proxy URL's user part in the script.
    ...(UUID.test(threadId) ? { KOBE_THREAD_ID: threadId.toLowerCase() } : {}),
    NO_PROXY: wiring.noProxy,
    no_proxy: wiring.noProxy,
  };
}

/** One Pi process's egress token file: written atomically, serialised, never logged. */
export class EgressTokenFile {
  readonly path: string;
  #written: string | undefined;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  write(token: string): Promise<void> {
    if (!TOKEN.test(token))
      return Promise.reject(new Error("egress token has unexpected characters"));
    const next = this.#chain.then(async () => {
      if (this.#written === token) return;
      const temp = `${this.path}.${randomBytes(8).toString("hex")}.tmp`;
      try {
        // `wx`: a symlink or FIFO planted at the temp path is never followed.
        await writeFile(temp, `${token}\n`, { mode: 0o600, flag: "wx" });
        await rename(temp, this.path);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
      this.#written = token;
    });
    this.#chain = next.catch(() => undefined);
    return next;
  }

  /** Whether the file holds the token last written (tests and diagnostics). */
  async holds(token: string): Promise<boolean> {
    await this.#chain;
    return (await readFile(this.path, "utf8").catch(() => "")) === `${token}\n`;
  }
}
