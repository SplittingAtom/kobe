/**
 * Where a reload may resume a run's stream instead of replaying it from seq 0. When every event so
 * far is reflected in committed entries (no message streaming, nothing uncommitted) the live state
 * is small: the seq, the committed entry ids, tool activity (denials, blocked domains…) and
 * notices. That is kept per tab in sessionStorage; on reload, if the thread's entries contain every
 * entry it lists, the stream resumes after its seq (`starting_after`). Otherwise, and on another
 * device, the run is replayed from 0, which is always correct.
 */
import type { LiveRun, ToolActivity } from "./live";

export interface ResumeStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

const PREFIX = "kobe.chat.resume.";
const MAX_BYTES = 200_000;
const MAX_PREVIEW = 2_000;

/** sessionStorage, or undefined where it is blocked (private mode, sandboxed frames). */
export function browserResumeStore(): ResumeStore | undefined {
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) return undefined;
    return {
      get: (key) => storage.getItem(key),
      set: (key, value) => storage.setItem(key, value),
      remove: (key) => storage.removeItem(key),
    };
  } catch {
    return undefined;
  }
}

/** Tool activity without what the entries already hold (inputs) and with short previews. */
function trimTool(tool: ToolActivity): ToolActivity {
  return {
    ...tool,
    ...(tool.call ? { call: { ...tool.call, input: {} } } : {}),
    ...(tool.result
      ? { result: { ...tool.result, preview: tool.result.preview.slice(0, MAX_PREVIEW) } }
      : {}),
    ...(tool.approvalRequested
      ? { approvalRequested: { ...tool.approvalRequested, input: {} } }
      : {}),
  };
}

/** Records a resume point when nothing of the run lives only in the stream. */
export function saveResumePoint(store: ResumeStore | undefined, run: LiveRun): void {
  if (!store || run.terminal !== undefined || run.messages.length > 0) return;
  if (run.committed.length === 0) return;
  const tools = Object.fromEntries(Object.entries(run.tools).map(([id, t]) => [id, trimTool(t)]));
  const text = JSON.stringify({ ...run, tools });
  try {
    if (text.length <= MAX_BYTES) store.set(PREFIX + run.runId, text);
    else store.remove(PREFIX + run.runId);
  } catch {
    // Storage full or blocked: a reload replays from 0 instead.
  }
}

export function clearResumePoint(store: ResumeStore | undefined, runId: string): void {
  try {
    store?.remove(PREFIX + runId);
  } catch {
    // Nothing to clean up when storage is blocked.
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** The saved state of `runId`, if every entry it lists is in `entryIds`. */
export function loadResumePoint(
  store: ResumeStore | undefined,
  runId: string,
  entryIds: ReadonlySet<string>,
): LiveRun | undefined {
  let raw: string | null;
  try {
    raw = store?.get(PREFIX + runId) ?? null;
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;
  try {
    const run = JSON.parse(raw) as Partial<LiveRun>;
    const valid =
      run.runId === runId &&
      typeof run.lastSeq === "number" &&
      Number.isSafeInteger(run.lastSeq) &&
      run.lastSeq > 0 &&
      typeof run.started === "boolean" &&
      typeof run.promptCommitted === "boolean" &&
      isStringArray(run.committed) &&
      run.committed.every((id) => entryIds.has(id)) &&
      Array.isArray(run.messages) &&
      run.messages.length === 0 &&
      Array.isArray(run.notices) &&
      run.tools !== null &&
      typeof run.tools === "object" &&
      run.bound !== null &&
      typeof run.bound === "object" &&
      run.terminal === undefined;
    return valid ? (run as LiveRun) : undefined;
  } catch {
    return undefined;
  }
}
