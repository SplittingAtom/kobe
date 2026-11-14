import { readFileSync } from "node:fs";
import { neutralizeMemoryMarkers } from "./memory-fence.js";
import { sanitizeRememberInput } from "./memory-tools.js";
import { TOOL_COMMIT_PROJECT, TOOL_RECALL, TOOL_REMEMBER } from "./protocol.js";

/**
 * Per-run memory and project wiring of the kobe-tools extension (KOBE-157, review of #205). The agent writes the
 * run's memory file (`KOBE_MEMORY_FILE`, memory/context-file.ts) before every prompt, so a change
 * to memory never restarts Pi:
 *  - `tools`: whether memory is on for this run; `remember` / `recall` are active only then;
 *  - `known` / `picks` (KOBE-383): "What Kobe knows", the stable part first and the per-message
 *    picks after the project instructions; added with or without Notes (Policy reaches every agent);
 *  - `text`: the run's memory section (already sanitised, capped and fenced by the agent), added
 *    to that run's system prompt only: not part of the launch, not stored in the session;
 *  - `project` and `viewing` (KOBE-245, KOBE-462): the project instructions and the fenced file
 *    the user has open, added the same way;
 *  - `project_write` (KOBE-580): the viewer may edit the run's project (`run.start.project.access`
 *    is `write`); `commit_project` is active only then (registerProjectHooks).
 * An unreadable or malformed file means no tools and no text (fail closed).
 */
export interface MemoryRunFile {
  readonly tools: boolean;
  readonly text: string;
  /** What Kobe knows, stable part (KOBE-383): first, with or without Notes. */
  readonly known: string;
  /** What Kobe knows, per-message picks (KOBE-383): after the project instructions. */
  readonly picks: string;
  /** The project-instructions block (KOBE-245); independent of whether memory is on. */
  readonly project: string;
  /** The viewed-file section (KOBE-462); independent of whether memory is on. */
  readonly viewing: string;
  /** Sync conflicts told at the run's start (KOBE-492): part of the run's system prompt. */
  readonly conflicts: string;
  /** Sync conflicts told mid-run (KOBE-492): a custom message before each later model call. */
  readonly conflictsLive: string;
  /** The viewer may edit the run's project (KOBE-580): `commit_project` is listed. */
  readonly projectWrite: boolean;
}
const OFF: MemoryRunFile = {
  tools: false,
  text: "",
  known: "",
  picks: "",
  project: "",
  viewing: "",
  conflicts: "",
  conflictsLive: "",
  projectWrite: false,
};

const optionalText = (value: unknown): string | undefined | false =>
  value === undefined ? undefined : typeof value === "string" ? value : false;

export function readMemoryRunFile(
  file: string | undefined,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): MemoryRunFile {
  if (file === undefined) return OFF;
  try {
    const value: unknown = JSON.parse(read(file));
    if (typeof value !== "object" || value === null) return OFF;
    const record = value as Record<string, unknown>;
    const { tools, text } = record;
    if (typeof tools !== "boolean" || typeof text !== "string") return OFF;
    // The other blocks are absent in files from an older agent: no such block.
    const project = optionalText(record.project);
    const viewing = optionalText(record.viewing);
    const conflicts = optionalText(record.conflicts);
    const conflictsLive = optionalText(record.conflicts_live);
    const known = optionalText(record.known);
    const picks = optionalText(record.picks);
    if ([project, viewing, conflicts, conflictsLive, known, picks].includes(false)) return OFF;
    // Absent in files from an older agent: no write access (fail closed).
    const projectWrite = record.project_write ?? false;
    if (typeof projectWrite !== "boolean") return OFF;
    return {
      tools,
      text: tools ? text : "",
      known: known || "",
      picks: picks || "",
      project: project || "",
      viewing: viewing || "",
      conflicts: conflicts || "",
      conflictsLive: conflictsLive || "",
      projectWrite,
    };
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
    // Stable first, so the provider caches the longest prefix (KOBE-383, Q6): What Kobe knows'
    // stable part, Notes, project instructions; then what changes per message.
    const { known, text, project, picks, viewing, conflicts } = state();
    const parts = [known, text, project, picks, viewing, conflicts].filter((part) => part !== "");
    return parts.length === 0
      ? undefined
      : { systemPrompt: `${event.systemPrompt}\n\n${parts.join("\n\n")}` };
  }) as never);
  // Sync conflicts told mid-run (KOBE-492): before each later model call of the run, a custom
  // message (Pi sends it in user role; the text says it is a Kobe notice). Not stored in the
  // session: Pi's `context` result only shapes this request.
  // Tool results are rewritten for each request too (KOBE-383 review M1): a copy of a memory
  // block with the thread's nonce (stable across runs) never works as a fence there.
  pi.on("context", ((event: { messages: unknown[] }) => {
    const { conflictsLive } = state();
    const cleaned = neutralizeToolResults(event.messages);
    if (conflictsLive === "") return cleaned === event.messages ? undefined : { messages: cleaned };
    return { messages: [...cleaned, conflictNoteMessage(conflictsLive)] };
  }) as never);
}

/**
 * `commit_project` (KOBE-580) is registered with the `projects` capability but listed to the model
 * only in runs whose viewer may edit the project: a reader's runs never offer it (spec CM6, PR3).
 * Re-evaluated at every prompt, like the memory tools; an unreadable run file means not listed.
 */
export function registerProjectHooks(
  pi: MemoryHooksApi,
  file: string | undefined,
  read?: (path: string) => string,
): void {
  const syncTools = () => {
    const active = pi.getActiveTools().filter((name) => name !== TOOL_COMMIT_PROJECT);
    const write = readMemoryRunFile(file, read).projectWrite;
    pi.setActiveTools(write ? [...active, TOOL_COMMIT_PROJECT] : active);
  };
  pi.on("input", syncTools as never);
}

/** `customType` of the mid-run sync conflict note (KOBE-492). */
export const CONFLICT_NOTE_TYPE = "kobe-sync-conflict";

/** The Pi custom message that carries a mid-run sync conflict note (never displayed). */
export function conflictNoteMessage(text: string): Record<string, unknown> {
  return {
    role: "custom",
    customType: CONFLICT_NOTE_TYPE,
    content: text,
    display: false,
    timestamp: Date.now(),
  };
}

/**
 * Pi's messages with every tool result's text put through `neutralizeMemoryMarkers`, except
 * `recall` (its blocks are real, sanitised memory with their own fresh nonce). The same array when
 * nothing changed, so the request is untouched.
 */
export function neutralizeToolResults(messages: readonly unknown[]): unknown[] {
  let changed = false;
  const out = messages.map((message) => {
    if (typeof message !== "object" || message === null) return message;
    const m = message as Record<string, unknown>;
    if (m.role !== "toolResult" || m.toolName === TOOL_RECALL) return message;
    const content = cleanContent(m.content);
    if (content === m.content) return message;
    changed = true;
    return { ...m, content };
  });
  return changed ? out : (messages as unknown[]);
}

function cleanContent(content: unknown): unknown {
  if (typeof content === "string") {
    const clean = neutralizeMemoryMarkers(content);
    return clean === content ? content : clean;
  }
  if (!Array.isArray(content)) return content;
  let changed = false;
  const blocks = content.map((block: unknown) => {
    if (typeof block !== "object" || block === null) return block;
    const b = block as Record<string, unknown>;
    if (b.type !== "text" || typeof b.text !== "string") return block;
    const text = neutralizeMemoryMarkers(b.text);
    if (text === b.text) return block;
    changed = true;
    return { ...b, text };
  });
  return changed ? blocks : content;
}
