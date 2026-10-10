import { readFileSync } from "node:fs";
import { sanitizeRememberInput } from "./memory-tools.js";
import { TOOL_RECALL, TOOL_REMEMBER } from "./protocol.js";

/**
 * Per-run memory and project wiring of the kobe-tools extension (KOBE-157, review of #205). The agent writes the
 * run's memory file (`KOBE_MEMORY_FILE`, memory/context-file.ts) before every prompt, so a change
 * to memory never restarts Pi:
 *  - `tools`: whether memory is on for this run; `remember` / `recall` are active only then;
 *  - `text`: the run's memory section (already sanitised, capped and fenced by the agent), added
 *    to that run's system prompt only: not part of the launch, not stored in the session.
 * An unreadable or malformed file means no tools and no text (fail closed).
 */
export interface MemoryRunFile {
  readonly tools: boolean;
  readonly text: string;
  /** The project-instructions block (KOBE-245); independent of whether memory is on. */
  readonly project: string;
}
const OFF: MemoryRunFile = { tools: false, text: "", project: "" };

export function readMemoryRunFile(
  file: string | undefined,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): MemoryRunFile {
  if (file === undefined) return OFF;
  try {
    const value: unknown = JSON.parse(read(file));
    if (typeof value !== "object" || value === null) return OFF;
    const { tools, text, project } = value as Record<string, unknown>;
    if (typeof tools !== "boolean" || typeof text !== "string") return OFF;
    // `project` is absent in files from an older agent: no project block.
    if (project !== undefined && typeof project !== "string") return OFF;
    return { tools, text: tools ? text : "", project: project ?? "" };
  } catch {
    return OFF;
  }
}

/** The slice of Pi's `ExtensionAPI` these hooks use. */
export interface MemoryHooksApi {
  on(event: string, handler: (event: never) => unknown): unknown;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

const MEMORY_TOOL_NAMES = [TOOL_REMEMBER, TOOL_RECALL];

export function installMemoryHooks(
  pi: MemoryHooksApi,
  file: string | undefined,
  read?: (path: string) => string,
): void {
  const state = () => readMemoryRunFile(file, read);
  // Runs before kobe-policy (loaded last): the approval card shows the content as it is stored.
  pi.on("tool_call", ((event: { toolName: string; input: Record<string, unknown> }) => {
    if (event.toolName === TOOL_REMEMBER && typeof event.input === "object") {
      sanitizeRememberInput(event.input);
    }
  }) as never);
  // Memory is on or off per run (team, project and user switches): list the tools only when on.
  const syncTools = () => {
    const active = pi.getActiveTools().filter((name) => !MEMORY_TOOL_NAMES.includes(name));
    pi.setActiveTools(state().tools ? [...active, ...MEMORY_TOOL_NAMES] : active);
  };
  pi.on("input", syncTools as never);
  pi.on("before_agent_start", ((event: { systemPrompt: string }) => {
    const { text, project } = state();
    const parts = [text, project].filter((part) => part !== "");
    return parts.length === 0
      ? undefined
      : { systemPrompt: `${event.systemPrompt}\n\n${parts.join("\n\n")}` };
  }) as never);
}
