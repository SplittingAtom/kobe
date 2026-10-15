import type { PiSessionEntry } from "@kobe/protocol";

/**
 * Finding a run's prompt in Pi's entries after the run has ended (KOBE-290). The sandbox is
 * untrusted and the run is over, so nothing of what it reports is taken on its word: the prompt is
 * located by the entry tree from the run's expected branch point (never by array order), and every
 * entry on the way must have exactly the shape Pi writes, with values the server can predict from
 * its own records:
 *
 * - the run's `kobe.branch` marker (the sandbox agent's, `data.run_id` = the run);
 * - `model_change` to the run's gateway model under the `kobe` provider, `thinking_level_change`
 *   to one of Pi's levels (Pi writes these at a new session's root, and a `model_change` under the
 *   marker when the branch's model differs);
 * - at a branch-less run's root only, Pi's `system` entry ({@link isRunSystemEntry});
 * - one user message whose text is `runs.input`, followed by exactly the attached-files block
 *   `promptWithAttachments` (sandbox-agent) builds from the run's own attachments, and one inline
 *   image per attachment the block says is shown, of that attachment's type and bounded size.
 *
 * Anything else (an answer, a tool result, any other `system` message, another run's prompt, extra
 * fields) refuses the prompt.
 */
export type FoundPrompt =
  /** The run's setup entries and its prompt, in parent order, as Pi wrote them. */
  | { readonly kind: "valid"; readonly chain: readonly PiSessionEntry[] }
  /** Pi's entries hold nothing for this run (no marker, or nothing under it yet). */
  | { readonly kind: "absent" }
  /** Where this run's prompt should be there is something else (text, shape or entry). */
  | { readonly kind: "mismatch" };

/** A file attached to the run, as `run.start.attachments` named it (`listRunAttachments`). */
export interface PromptAttachment {
  readonly path: string;
  readonly mime_type: string;
}

export interface PromptRunRecord {
  readonly id: string;
  /** The member's message as the server stored it. */
  readonly input: string;
  /** Where the run branched (`kobe.branch` marker's parent); null: a branch-less run. */
  readonly parentEntryId: string | null;
  /** The run's attachments, in `run.start` order. */
  readonly attachments: readonly PromptAttachment[];
  /** The run's gateway model (Pi's `model_change.modelId`); undefined: none can be accepted. */
  readonly gatewayModel: string | undefined;
  /**
   * The agent prompt the server sent in `run.start` (`config.system_prompt`): null when it sent
   * none, undefined when its record is gone (then no `system` entry can be accepted).
   */
  readonly systemPrompt: string | null | undefined;
}

/** Image types the agent inlines (`NATIVE_IMAGE_TYPES` there and in `uploads/attach-list.ts`). */
export const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
/** The agent's `NATIVE_IMAGE_MAX_BYTES`: larger images are listed by path, never inlined. */
const INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const INLINE_IMAGE_MAX_BASE64 = Math.ceil(INLINE_IMAGE_MAX_BYTES / 3) * 4;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const ATTACHED = "\n\nAttached files:\n";
const SHOWN = " - shown to you as an image";
const BY_PATH = " - not shown inline; open it from this path";

const KOBE_PROVIDER = "kobe";
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
/** Setup entries Pi writes before a prompt. */
const MAX_SETUP = 4;
const MAX_TIMESTAMP = 64;

type Loose = Record<string, unknown>;

const exactKeys = (o: Loose, keys: readonly string[]) =>
  Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

const ENTRY_KEYS = ["type", "id", "parentId", "timestamp"] as const;

function entryShape(entry: PiSessionEntry, extra: readonly string[]): boolean {
  return (
    exactKeys(entry as Loose, [...ENTRY_KEYS, ...extra]) && entry.timestamp.length <= MAX_TIMESTAMP
  );
}

function message(entry: PiSessionEntry): Loose | undefined {
  const m = (entry as Loose).message;
  return typeof m === "object" && m !== null && !Array.isArray(m) ? (m as Loose) : undefined;
}

function isUserMessage(entry: PiSessionEntry): boolean {
  return entry.type === "message" && message(entry)?.role === "user";
}

function isRunMarker(entry: PiSessionEntry, runId: string): boolean {
  const e = entry as { customType?: unknown; data?: unknown };
  const data = e.data as Loose | null | undefined;
  return (
    entry.type === "custom" &&
    entryShape(entry, ["customType", "data"]) &&
    e.customType === "kobe.branch" &&
    typeof data === "object" &&
    data !== null &&
    exactKeys(data, ["run_id"]) &&
    data.run_id === runId
  );
}

/** `model_change` to the run's model, or `thinking_level_change` to one of Pi's levels. */
export function isRunSetup(entry: PiSessionEntry, gatewayModel: string | undefined): boolean {
  const e = entry as Loose;
  if (entry.type === "model_change") {
    return (
      gatewayModel !== undefined &&
      entryShape(entry, ["provider", "modelId"]) &&
      e.provider === KOBE_PROVIDER &&
      e.modelId === gatewayModel
    );
  }
  if (entry.type === "thinking_level_change") {
    return (
      entryShape(entry, ["thinkingLevel"]) &&
      typeof e.thinkingLevel === "string" &&
      THINKING_LEVELS.has(e.thinkingLevel)
    );
  }
  return false;
}

/** The sandbox's workspace (`KOBE_WORKSPACE_DIR`), as Pi records its cwd. */
const WORKSPACE = "/workspace";
/** Pi's own system entry is a few KB (its tools' schemas included); MCP tools add some. */
const SYSTEM_ENTRY_MAX_BYTES = 256 * 1024;
const PI_SECTIONS = ["preamble", "tools", "rules", "docs", "cwd"] as const;

/**
 * Pi's `system` entry at a branch-less run's root (a new session): exactly Pi's fields, its own
 * sections as plain text, the addendum exactly the agent prompt the server sent in `run.start`,
 * the sandbox's workspace as cwd, and a bounded size. Pi's own sections (preamble, tools, rules,
 * docs) can't be checked; the early mirror of an active run takes them as they come, so this is
 * no looser.
 */
export function isRunSystemEntry(
  entry: PiSessionEntry,
  systemPrompt: string | null | undefined,
): boolean {
  const m = message(entry);
  if (systemPrompt === undefined || entry.type !== "message" || m === undefined) return false;
  if (!entryShape(entry, ["message"])) return false;
  if (Buffer.byteLength(JSON.stringify(entry), "utf8") > SYSTEM_ENTRY_MAX_BYTES) return false;
  if (!exactKeys(m, ["role", "content", "sections", "timestamp", "toolsAdded"])) return false;
  if (m.role !== "system" || m.content !== "" || typeof m.timestamp !== "number") return false;
  const sections = m.sections as Loose | null;
  const keys = systemPrompt === null ? [...PI_SECTIONS] : [...PI_SECTIONS, "addendum"];
  if (typeof sections !== "object" || sections === null || !exactKeys(sections, keys)) return false;
  if (!Object.values(sections).every((v) => typeof v === "string")) return false;
  if (sections.cwd !== `<cwd>\n${WORKSPACE}\n</cwd>`) return false;
  if (systemPrompt !== null && sections.addendum !== `<addendum>\n${systemPrompt}\n</addendum>`)
    return false;
  const tools = m.toolsAdded;
  return (
    Array.isArray(tools) &&
    tools.every((t) => typeof t === "object" && t !== null && typeof (t as Loose).name === "string")
  );
}

/** The lines Pi's prompt may hold for one attachment (inlined or not is the agent's choice). */
function attachmentLines(a: PromptAttachment): readonly string[] {
  const base = `- ${a.path} (${a.mime_type})`;
  if (INLINE_IMAGE_TYPES.has(a.mime_type)) return [base + SHOWN, base + BY_PATH];
  if (a.mime_type.startsWith("image/") || a.mime_type === "application/pdf")
    return [base + BY_PATH];
  return [base];
}

/** The attachments the text says are shown inline, or undefined if it is not the run's text. */
function shownAttachments(
  text: string,
  input: string,
  attachments: readonly PromptAttachment[],
): PromptAttachment[] | undefined {
  if (attachments.length === 0) return text === input ? [] : undefined;
  if (!text.startsWith(input + ATTACHED)) return undefined;
  const lines = text.slice(input.length + ATTACHED.length).split("\n");
  if (lines.length !== attachments.length) return undefined;
  const shown: PromptAttachment[] = [];
  for (const [i, a] of attachments.entries()) {
    const line = lines[i] ?? "";
    if (!attachmentLines(a).includes(line)) return undefined;
    if (line.endsWith(SHOWN)) shown.push(a);
  }
  return shown;
}

function isInlineImage(part: Loose, attachment: PromptAttachment | undefined): boolean {
  return (
    attachment !== undefined &&
    exactKeys(part, ["type", "data", "mimeType"]) &&
    part.type === "image" &&
    part.mimeType === attachment.mime_type &&
    typeof part.data === "string" &&
    part.data.length <= INLINE_IMAGE_MAX_BASE64 &&
    BASE64.test(part.data)
  );
}

/**
 * Pi's user message entry for exactly this run: its text (`runs.input` and the run's own
 * attached-files block, or nothing after the input), then one image per attachment shown inline.
 */
export function isRunPrompt(
  entry: PiSessionEntry,
  run: Pick<PromptRunRecord, "input" | "attachments">,
): boolean {
  const m = message(entry);
  if (!isUserMessage(entry) || m === undefined || !entryShape(entry, ["message"])) return false;
  const keys = m.timestamp === undefined ? ["role", "content"] : ["role", "content", "timestamp"];
  if (!exactKeys(m, keys)) return false;
  if (m.timestamp !== undefined && typeof m.timestamp !== "number") return false;
  if (typeof m.content === "string") {
    return shownAttachments(m.content, run.input, run.attachments)?.length === 0;
  }
  if (!Array.isArray(m.content) || m.content.length === 0) return false;
  const [first, ...images] = m.content as Loose[];
  if (first === undefined || !exactKeys(first, ["type", "text"]) || first.type !== "text")
    return false;
  if (typeof first.text !== "string") return false;
  const shown = shownAttachments(first.text, run.input, run.attachments);
  if (shown === undefined || images.length !== shown.length) return false;
  return images.every((part, i) => isInlineImage(part, shown[i]));
}

/**
 * The run's prompt in Pi's new entries: from the run's own `kobe.branch` marker under its branch
 * point (required when it has one; a branch-less run starts at the root), through the run's setup
 * entries only, to its prompt ({@link isRunPrompt}). Any other entry there refuses it.
 */
export function findRunPrompt(
  entries: readonly PiSessionEntry[],
  run: PromptRunRecord,
): FoundPrompt {
  const chain: PiSessionEntry[] = [];
  let at: string | null = null;
  if (run.parentEntryId !== null) {
    const marker = entries.find((e) => e.parentId === run.parentEntryId && isRunMarker(e, run.id));
    if (marker === undefined) return { kind: "absent" };
    chain.push(marker);
    at = marker.id;
  }
  for (let step = 0; step <= MAX_SETUP; step += 1) {
    const children = entries.filter((e) => e.parentId === at);
    // Under the run's marker nothing but this run's entries may hang (it is new); at the root a
    // branch-less run's session holds only what Pi wrote for it.
    if (children.length === 0) return { kind: "absent" };
    if (children.length > 1) return { kind: "mismatch" };
    const [next] = children as [PiSessionEntry];
    if (isUserMessage(next)) {
      return isRunPrompt(next, run)
        ? { kind: "valid", chain: [...chain, next] }
        : { kind: "mismatch" };
    }
    // Pi's system entry only on a new session's root path (a branch-less run), at most once.
    const system =
      run.parentEntryId === null &&
      !chain.some((e) => e.type === "message") &&
      isRunSystemEntry(next, run.systemPrompt);
    if (!system && !isRunSetup(next, run.gatewayModel)) return { kind: "mismatch" };
    chain.push(next);
    at = next.id;
  }
  return { kind: "mismatch" };
}
