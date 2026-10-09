import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import type { ExecTransport } from "./client.js";
import { connect } from "./connect.js";
import { TOOL_HOME_ENV } from "./protocol.js";
import { registerExecTools, type ExtensionApiLike, type PiToolFactories } from "./tools.js";

/**
 * kobe-exec: the Pi 1.0.x extension that makes Pi's seven built-in tools run somewhere other than
 * Pi (KOBE-167, docs/design/paired-tool-uid.md option B). Every call goes through kobe-policy first
 * (the last extension, so it checks the call before this extension's `execute` runs), then over
 * fd 5 (`KOBE_EXEC_FD`) to kobe-sandbox-agent, which relays it to an executor process running as
 * the Pi identity's partner uid. The extension itself never touches the file system or starts a
 * process for a tool.
 *
 * Fail closed: it is loaded only when the agent wants the tools routed. Loaded without a usable
 * channel it still registers all seven tools, each failing with an explanation, because registering
 * nothing would leave Pi's local built-ins in place.
 *
 * Self-contained by design: node builtins, Pi's own package (resolved by Pi's loader) and files in
 * this directory, because the image ships it on its own (root-owned, read-only,
 * `/opt/kobe/pi-extensions/kobe-exec`). It holds no credential and no address: the channel is its
 * only way out. The channel is opened once per Pi process (module scope).
 */
let transport: ExecTransport | undefined;
let homes: { piHome: string; toolHome: string } | undefined;

export default function kobeExec(pi: ExtensionApiLike): void {
  transport ??= connect(process.env, (message) => process.stderr.write(`${message}\n`));
  // Read once and removed, like the fd variable: tools must not see it.
  const toolHome = process.env[TOOL_HOME_ENV];
  Reflect.deleteProperty(process.env, TOOL_HOME_ENV);
  const piHome = process.env.HOME;
  if (toolHome !== undefined && piHome !== undefined) homes ??= { piHome, toolHome };
  registerExecTools(
    pi,
    transport,
    piCodingAgent as unknown as PiToolFactories,
    process.cwd(),
    homes,
  );
}
