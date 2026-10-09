import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PI_AVAILABLE } from "../testing/real-pi.js";

/**
 * Pi's own places that start a process (KOBE-167; docs/design/paired-tool-uid.md, "Pi's own spawn
 * sites"). kobe-exec moves the seven built-in tools out of Pi; whatever else in Pi 1.0.0 can start
 * a process stays in Pi's uid, and each such place is listed here with why that is acceptable. The
 * test pins the list to the installed Pi: a Pi upgrade that adds, moves or drops a spawn site fails
 * here until the new site has been judged (and the real-Pi suites rerun, as the pin rule says).
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(
  HERE,
  "../../../../images/sandbox/pi/node_modules/@earendil-works/pi-coding-agent/dist",
);

type Disposition = "replaced" | "pi-config" | "unreachable";

/** module (under dist/) -> how it is handled. */
const SITES: Readonly<Record<string, { readonly how: Disposition; readonly why: string }>> = {
  "core/tools/bash.js": { how: "replaced", why: "bash tool: kobe-exec routes it (and user_bash)" },
  "core/tools/grep.js": {
    how: "replaced",
    why: "grep tool spawns rg: kobe-exec runs rg in the executor",
  },
  "core/tools/find.js": {
    how: "replaced",
    why: "find tool spawns fd: kobe-exec runs fd in the executor",
  },
  "utils/shell.js": {
    how: "replaced",
    why: "shell lookup for the bash tool and `!command` values",
  },
  "core/resolve-config-value.js": {
    how: "pi-config",
    why: "`!command` values in models.json / auth.json / settings.json: the files are the agent's guarded placeholders or Pi's own stores in agent/, which the partner uid cannot write (KOBE-166/169)",
  },
  "core/exec.js": {
    how: "unreachable",
    why: "pi.exec() for extensions: only Kobe's root-owned extensions load (--no-extensions) and none calls it",
  },
  "core/footer-data-provider.js": {
    how: "unreachable",
    why: "git branch for the TUI footer; interactive mode only",
  },
  "core/package-manager.js": {
    how: "unreachable",
    why: "npm/git installs of Pi packages: `settings.json` packages is empty and guarded, PI_OFFLINE=1, no install command over RPC",
  },
  "package-manager-cli.js": {
    how: "unreachable",
    why: "`pi install` & co. subcommands; the agent runs `pi --mode rpc` only",
  },
  "config.js": {
    how: "unreachable",
    why: "self-update detection (npm root -g); PI_SKIP_VERSION_CHECK=1, offline",
  },
  "utils/child-process.js": { how: "unreachable", why: "spawn helpers used by the sites above" },
  "utils/paths.js": {
    how: "unreachable",
    why: "xattr/setfattr for cloud-sync marks, called by the package manager only",
  },
  "utils/tools-manager.js": {
    how: "unreachable",
    why: "rg/fd probe and download (ensureTool): called by the replaced grep/find and interactive start-up; PI_OFFLINE=1",
  },
  "utils/clipboard-command.js": {
    how: "unreachable",
    why: "xclip/wl-copy/pbcopy for the TUI editor; interactive mode only",
  },
  "utils/open-browser.js": {
    how: "unreachable",
    why: "xdg-open for OAuth logins; no login flow over RPC, MCP goes through mcp-proxy",
  },
  "modes/interactive/interactive-mode.js": { how: "unreachable", why: "interactive TUI" },
  "modes/interactive/external-editor.js": { how: "unreachable", why: "$EDITOR in the TUI" },
  "modes/interactive/session-share.js": {
    how: "unreachable",
    why: "`gh gist` share command in the TUI",
  },
  "modes/interactive/components/session-selector.js": {
    how: "unreachable",
    why: "`trash` in the TUI session list",
  },
  "modes/rpc/rpc-client.js": {
    how: "unreachable",
    why: "client library for programs that start Pi; never used inside Pi",
  },
};

function scan(dir: string, root = dir): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "bundle" && entry.name !== "examples") found.push(...scan(file, root));
    } else if (entry.name.endsWith(".js")) {
      const text = readFileSync(file, "utf8");
      // `child_process` itself, or Pi's wrapper around it (utils/child-process.js).
      if (/\bchild_process\b|\bspawnProcess(?:Sync)?\(/.test(text)) {
        found.push(path.relative(root, file));
      }
    }
  }
  return found.sort();
}

describe.skipIf(!PI_AVAILABLE)("Pi 1.0.0's process-spawning modules (KOBE-167 inventory)", () => {
  it("are exactly the ones judged in this list", () => {
    expect(scan(DIST)).toEqual(Object.keys(SITES).sort());
  });

  it("leave only the guarded-config `!command` site that can run in a Kobe launch, in Pi's uid", () => {
    const reachable = Object.entries(SITES).filter(([, site]) => site.how === "pi-config");
    expect(reachable.map(([file]) => file)).toEqual(["core/resolve-config-value.js"]);
  });

  it("the MCP extension starts stdio servers only from mcp.json, which Kobe does not write", () => {
    const runtime = readFileSync(path.join(DIST, "extensions/mcp/runtime.js"), "utf8");
    expect(runtime).toContain("StdioTransport");
    // The servers come from the config object, not from tool input.
    expect(runtime).toMatch(/command: expandHome\(config\.command\)/);
  });
});
