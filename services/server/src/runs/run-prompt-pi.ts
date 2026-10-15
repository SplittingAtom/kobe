import type { PiSessionEntry } from "@kobe/protocol";

/**
 * Finding a run's prompt in Pi's entries after the run has ended (KOBE-290). The sandbox is
 * untrusted and the run is over, so nothing of what it reports is taken on its word: the prompt is
 * located by the entry tree from the run's expected branch point (never by array order), its text
 * must be the run's own input (`runs.input`, the server's record), and only Pi's setup entries may
 * sit between the branch point and the prompt. Anything else (an answer, a tool result, a second
 * prompt, another run's prompt) is refused.
 */
export type FoundPrompt =
  /** The run's setup entries and its prompt, in parent order, as Pi wrote them. */
  | { readonly kind: "valid"; readonly chain: readonly PiSessionEntry[] }
  /** Pi's entries hold no prompt of this run. */
  | { readonly kind: "absent" }
  /** Where this run's prompt should be there is a prompt, but not this run's (text or shape). */
  | { readonly kind: "mismatch" };

export interface PromptRunRecord {
  readonly id: string;
  /** The member's message as the server stored it. */
  readonly input: string;
  /** Where the run branched (`kobe.branch` marker's parent); null: a branch-less run. */
  readonly parentEntryId: string | null;
}

/** Setup entries Pi writes before a prompt (a new session: model, thinking level, system). */
const MAX_SETUP = 8;

/** `promptWithAttachments` (sandbox-agent) appends this block, one line per attached file. */
const ATTACHED = "\n\nAttached files:\n";
const ATTACHMENT_LINE =
  /^- [^\n]{1,1024} \([^()\n]{1,255}\)( - shown to you as an image| - not shown inline; open it from this path)?$/;

type Loose = Record<string, unknown>;

function message(entry: PiSessionEntry): Loose | undefined {
  const m = (entry as Loose).message;
  return typeof m === "object" && m !== null && !Array.isArray(m) ? (m as Loose) : undefined;
}

function isUserMessage(entry: PiSessionEntry): boolean {
  return entry.type === "message" && message(entry)?.role === "user";
}

function isBranchMarkerOf(entry: PiSessionEntry, runId: string): boolean {
  const e = entry as { customType?: unknown; data?: { run_id?: unknown } };
  return entry.type === "custom" && e.customType === "kobe.branch" && e.data?.run_id === runId;
}

function isSetup(entry: PiSessionEntry): boolean {
  return (
    entry.type === "model_change" ||
    entry.type === "thinking_level_change" ||
    (entry.type === "message" && message(entry)?.role === "system")
  );
}

/** The prompt's text is the input, or the input plus the attached-files block. */
function isRunText(text: string, input: string): boolean {
  if (text === input) return true;
  if (!text.startsWith(input + ATTACHED)) return false;
  const lines = text.slice(input.length + ATTACHED.length).split("\n");
  return lines.length > 0 && lines.every((line) => ATTACHMENT_LINE.test(line));
}

const only = (o: Loose, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));

/** Pi's user message entry for exactly this input: text first, then inline images, nothing else. */
export function isRunPrompt(entry: PiSessionEntry, input: string): boolean {
  const m = message(entry);
  if (!isUserMessage(entry) || m === undefined) return false;
  if (!only(entry as Loose, ["type", "id", "parentId", "timestamp", "message"])) return false;
  if (!only(m, ["role", "content", "timestamp"])) return false;
  if (m.timestamp !== undefined && typeof m.timestamp !== "number") return false;
  if (typeof m.content === "string") return isRunText(m.content, input);
  if (!Array.isArray(m.content) || m.content.length === 0) return false;
  const [first, ...rest] = m.content as Loose[];
  if (first?.type !== "text" || typeof first.text !== "string" || !only(first, ["type", "text"]))
    return false;
  const images = rest.every(
    (p) =>
      p.type === "image" &&
      typeof p.data === "string" &&
      typeof p.mimeType === "string" &&
      only(p, ["type", "data", "mimeType"]),
  );
  return images && isRunText(first.text, input);
}

/**
 * The run's prompt in Pi's new entries: from the run's own `kobe.branch` marker under its branch
 * point (required when it has one; a branch-less run starts at the root), through setup entries
 * only, to the first user message, which must be {@link isRunPrompt}.
 */
export function findRunPrompt(
  entries: readonly PiSessionEntry[],
  run: PromptRunRecord,
): FoundPrompt {
  const chain: PiSessionEntry[] = [];
  let at: string | null = null;
  if (run.parentEntryId !== null) {
    const marker = entries.find(
      (e) => isBranchMarkerOf(e, run.id) && e.parentId === run.parentEntryId,
    );
    if (marker === undefined) return { kind: "absent" };
    chain.push(marker);
    at = marker.id;
  }
  for (let step = 0; step <= MAX_SETUP; step += 1) {
    const children = entries.filter((e) => e.parentId === at);
    const prompt = children.find(isUserMessage);
    if (prompt !== undefined) {
      return isRunPrompt(prompt, run.input)
        ? { kind: "valid", chain: [...chain, prompt] }
        : { kind: "mismatch" };
    }
    const setup = children.find(isSetup);
    if (setup === undefined) return { kind: "absent" };
    chain.push(setup);
    at = setup.id;
  }
  return { kind: "absent" };
}
