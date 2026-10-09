import { connectTools, filesEnabled, registerKobeTools, type ExtensionApiLike } from "./extension.js";
import type { ToolsTransport } from "./tools.js";

/**
 * kobe-tools: the Pi 1.0.x extension that gives the model Kobe's own tools (spec D13; KOBE-128):
 * `create_artifact` and `update_artifact`, `share_file` (only when the agent announced the `files`
 * capability: KOBE_TOOLS_FILES=1) and `remember` later. Each call goes
 * through kobe-policy first (it is the last extension, so it checks the tool call before this
 * extension's `execute` runs), then to kobe-sandbox-agent on fd 4 (`KOBE_TOOLS_FD`), which forwards
 * it to the Kobe server; the server's answer is the tool result.
 *
 * Self-contained by design: imports only node builtins and files in this directory, because the
 * image ships it on its own (root-owned, read-only, `/opt/kobe/pi-extensions/kobe-tools`). It holds
 * no credential and no server address: the channel is its only way out.
 *
 * The channel is opened once per Pi process (module scope); a re-evaluated module finds the fd
 * variable gone and registers nothing.
 */
let transport: ToolsTransport | undefined;
let files = false;
let connected = false;

export default function kobeTools(pi: ExtensionApiLike): void {
  if (!connected) {
    connected = true;
    files = filesEnabled(process.env);
    transport = connectTools({
      env: process.env,
      // stderr only: stdout is Pi's RPC stream.
      warn: (message) => process.stderr.write(`${message}\n`),
    });
  }
  registerKobeTools(pi, transport, { files });
}
