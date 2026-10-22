import {
  connectTools,
  fileEditsEnabled,
  filesEnabled,
  memoryEnabled,
  memoryFile,
  notebooksEnabled,
  projectsEnabled,
  registerKobeTools,
  skillDraftsEnabled,
  type ExtensionApiLike,
} from "./extension.js";
import type { ToolsTransport } from "./tools.js";

/**
 * kobe-tools: the Pi 1.0.x extension that gives the model Kobe's own tools (spec D13; KOBE-128):
 * `create_artifact` and `update_artifact`, `share_file` (only when the agent announced the `files`
 * capability: KOBE_TOOLS_FILES=1), `propose_project_file` (only with `projects`: KOBE_TOOLS_PROJECTS=1), `save_skill_draft` (only with `skill_drafts`: KOBE_TOOLS_SKILL_DRAFTS=1), `propose_file_edit` and `open_file` (only with `file_edits`: KOBE_TOOLS_FILE_EDITS=1), `run_python` (only with `notebooks`: KOBE_TOOLS_NOTEBOOKS=1) and `remember` / `recall` (only when the agent announced `memory`: KOBE_TOOLS_MEMORY=1). Each call goes
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
let projects = false;
let skillDrafts = false;
let fileEdits = false;
let notebooks = false;
let memory = false;
let memoryPath: string | undefined;
let connected = false;

export default function kobeTools(pi: ExtensionApiLike): void {
  if (!connected) {
    connected = true;
    files = filesEnabled(process.env);
    projects = projectsEnabled(process.env);
    skillDrafts = skillDraftsEnabled(process.env);
    fileEdits = fileEditsEnabled(process.env);
    notebooks = notebooksEnabled(process.env);
    memory = memoryEnabled(process.env);
    memoryPath = memoryFile(process.env);
    transport = connectTools({
      env: process.env,
      // stderr only: stdout is Pi's RPC stream.
      warn: (message) => process.stderr.write(`${message}\n`),
    });
  }
  registerKobeTools(pi, transport, {
    files,
    projects,
    skillDrafts,
    fileEdits,
    notebooks,
    memory,
    memoryFile: memoryPath,
  });
}
