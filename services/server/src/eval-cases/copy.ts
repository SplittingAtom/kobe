import { splitAppContext, splitSkillRequest } from "@kobe/protocol";
import { createHash } from "node:crypto";
import {
  EVAL_CASE_EARLIER_MAX_CHARS,
  EVAL_CASE_MAX_EARLIER_EXCHANGES,
  EVAL_CASE_TEXT_MAX_CHARS,
  EVAL_CASE_TOOL_OUTPUT_MAX_CHARS,
  canonicalJson,
  type EvalCaseContent,
  type EvalCaseOptions,
  type EvalCasePreview,
  type FeedbackReason,
} from "@kobe/protocol";
import { sql, type KobeTx } from "@kobe/db";
import { cutText } from "../threads/entry-output.js";
import { messageText } from "../threads/messages.js";

/**
 * The copy of one exchange that a shared eval case stores (KOBE-276), read from Postgres only
 * (never a sandbox or the object store). Every query states `team_id` and the run's thread (the
 * break-glass rule); the caller has already checked that the viewer owns the thread.
 *
 * - The prompt is the run's own input (`runs.input`, what the member sent), not Pi's user entry,
 *   which carries the attached-files block.
 * - The answer is the assistant text of the entries below the run's prompt entry
 *   (`runs.user_entry_id`), up to the next prompt; tool outputs are that run's tool results.
 * - Earlier turns are the prompts and answer texts above it on its branch.
 * - Attachments are the files uploaded with the run (names, types and sizes).
 * - An offloaded entry body (D15, over 64 KB) is left out and marks the copy `truncated`.
 *
 * Text is cut to the contract's limits, control characters other than newline and tab are
 * dropped and lone surrogates replaced, so the canonical JSON (the digest) is always defined.
 */

/** Entries walked below the prompt and above it (a run's answer and its branch). */
const MAX_ANSWER_ENTRIES = 200;
const MAX_BRANCH_DEPTH = 200;
/** Where Pi's user entry starts the attached-files block (sandbox-agent `promptWithAttachments`). */
const ATTACHED_MARK = "\n\nAttached files:\n";

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Printable, well-formed text (the copy's every string). */
export function cleanText(text: string): string {
  return text.replace(LONE_SURROGATE, "�").replace(CONTROL, "");
}

interface Cut {
  readonly text: string;
  readonly cut: boolean;
}

function capText(raw: string, max: number): Cut {
  const text = cleanText(raw).trim();
  return { text: cutText(text, max), cut: text.length > max };
}

/** Hex SHA-256 of the content's canonical JSON: what the preview shows is what the share stores. */
export function contentDigest(content: EvalCaseContent): string {
  return createHash("sha256").update(canonicalJson(content), "utf8").digest("hex");
}

export interface ExchangeSource {
  readonly teamId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly input: string;
  readonly userEntryId: string;
  readonly reasons: readonly FeedbackReason[];
  readonly comment: string | null;
}

type EntryRow = {
  readonly entry_id: string;
  readonly blob_ref: string | null;
  readonly payload: unknown;
};

const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

function messageOf(payload: unknown): Record<string, unknown> | undefined {
  return record(record(payload)?.message);
}

/** The run's own entries: everything below its prompt entry, up to (not into) the next prompt. */
async function answerEntries(tx: KobeTx, src: ExchangeSource): Promise<EntryRow[]> {
  const res = await tx.execute<EntryRow>(sql`
    WITH RECURSIVE d (entry_id, depth) AS (
      SELECT e.entry_id, 0 FROM thread_entries e
       WHERE e.team_id = ${src.teamId} AND e.thread_id = ${src.threadId}
         AND e.entry_id = ${src.userEntryId}
      UNION ALL
      SELECT c.entry_id, d.depth + 1 FROM d
        JOIN thread_entries c ON c.team_id = ${src.teamId} AND c.thread_id = ${src.threadId}
                             AND c.parent_id = d.entry_id
       WHERE d.depth < ${MAX_ANSWER_ENTRIES}
         AND NOT (c.type = 'message' AND c.payload -> 'message' ->> 'role' = 'user'))
    SELECT e.entry_id, e.blob_ref, e.payload FROM d
      JOIN thread_entries e ON e.team_id = ${src.teamId} AND e.thread_id = ${src.threadId}
                           AND e.entry_id = d.entry_id
     WHERE d.depth > 0 AND e.type = 'message'
     ORDER BY e.seq LIMIT ${MAX_ANSWER_ENTRIES}`);
  return res.rows;
}

/**
 * The message entries above the prompt on its branch, nearest first. `own` marks a prompt that a
 * run of this thread sent (`runs.user_entry_id`): a fork copies another thread's entries but not
 * its runs, so an inherited prompt is never `own` (KOBE-276 review B1).
 */
async function branchEntries(tx: KobeTx, src: ExchangeSource): Promise<BranchRow[]> {
  const res = await tx.execute<BranchRow & { depth: number }>(sql`
    WITH RECURSIVE b (entry_id, parent_id, depth) AS (
      SELECT e.entry_id, e.parent_id, 0 FROM thread_entries e
       WHERE e.team_id = ${src.teamId} AND e.thread_id = ${src.threadId}
         AND e.entry_id = ${src.userEntryId}
      UNION ALL
      SELECT p.entry_id, p.parent_id, b.depth + 1 FROM b
        JOIN thread_entries p ON p.team_id = ${src.teamId} AND p.thread_id = ${src.threadId}
                             AND p.entry_id = b.parent_id
       WHERE b.depth < ${MAX_BRANCH_DEPTH})
    SELECT e.entry_id, e.blob_ref, e.payload, b.depth,
           EXISTS (SELECT 1 FROM runs r
                    WHERE r.team_id = ${src.teamId} AND r.thread_id = ${src.threadId}
                      AND r.user_entry_id = e.entry_id) AS own
      FROM b
      JOIN thread_entries e ON e.team_id = ${src.teamId} AND e.thread_id = ${src.threadId}
                           AND e.entry_id = b.entry_id
     WHERE b.depth > 0 AND e.type = 'message'
     ORDER BY b.depth`);
  return res.rows;
}

type BranchRow = EntryRow & { readonly own: boolean };

interface ToolResult {
  readonly id: string;
  readonly tool: string;
  readonly isError: boolean;
  readonly text: string;
}

interface Answer {
  readonly text: Cut;
  readonly tools: readonly ToolResult[];
  readonly offloaded: boolean;
}

function readAnswer(rows: readonly EntryRow[]): Answer {
  const texts: string[] = [];
  const tools: ToolResult[] = [];
  let offloaded = false;
  for (const row of rows) {
    if (row.blob_ref !== null) {
      offloaded = true;
      continue;
    }
    const m = messageOf(row.payload);
    if (m?.role === "assistant") {
      const text = messageText(m.content).trim();
      if (text !== "") texts.push(text);
    } else if (m?.role === "toolResult" && typeof m.toolCallId === "string") {
      tools.push({
        id: m.toolCallId,
        tool: typeof m.toolName === "string" ? cleanText(m.toolName).slice(0, 128) : "",
        isError: m.isError === true,
        text: messageText(m.content),
      });
    }
  }
  return { text: capText(texts.join("\n\n"), EVAL_CASE_TEXT_MAX_CHARS), tools, offloaded };
}

type Turn = { readonly role: "user" | "assistant"; readonly text: string };

/**
 * Prompts and answer texts above the prompt, oldest first (tool-only turns left out): only whole
 * exchanges whose prompt this thread's own runs sent. The walk stops at the first prompt that
 * isn't (a fork's inherited history, another member's words) and drops its answer with it, and at
 * an offloaded entry (it can't tell where an exchange starts).
 */
function readBranch(rows: readonly BranchRow[]): { turns: Turn[]; offloaded: boolean } {
  const turns: Turn[] = [];
  let pending: Turn[] = [];
  for (const row of rows) {
    if (row.blob_ref !== null) return { turns, offloaded: true };
    const m = messageOf(row.payload);
    if (m?.role !== "user" && m?.role !== "assistant") continue;
    let text = messageText(m.content);
    if (m.role === "assistant") {
      if (text.trim() !== "") pending = [{ role: "assistant", text }, ...pending];
      continue;
    }
    if (!row.own) break;
    const at = text.indexOf(ATTACHED_MARK);
    if (at >= 0) text = text.slice(0, at);
    turns.unshift(...(text.trim() === "" ? [] : [{ role: "user" as const, text }]), ...pending);
    pending = [];
  }
  return { turns, offloaded: false };
}

/** The last `n` exchanges of `turns`: from the n-th prompt from the end, answers merged. */
function lastExchanges(turns: readonly Turn[], n: number): { turns: Turn[]; cut: boolean } {
  if (n === 0) return { turns: [], cut: false };
  const prompts = turns.flatMap((t, i) => (t.role === "user" ? [i] : []));
  const from = prompts.at(-n) ?? 0;
  const merged: Turn[] = [];
  for (const t of turns.slice(from)) {
    const prev = merged.at(-1);
    if (prev && prev.role === t.role)
      merged[merged.length - 1] = { ...prev, text: `${prev.text}\n\n${t.text}` };
    else merged.push(t);
  }
  let cut = false;
  const out = merged.map((t) => {
    const c = capText(t.text, EVAL_CASE_EARLIER_MAX_CHARS);
    cut ||= c.cut;
    return { role: t.role, text: c.text };
  });
  return { turns: out, cut };
}

type FileRow = {
  readonly id: string;
  readonly name: string;
  readonly mime_type: string;
  readonly size_bytes: string | number;
};

async function runAttachments(tx: KobeTx, src: ExchangeSource): Promise<FileRow[]> {
  const res = await tx.execute<FileRow>(sql`
    SELECT f.id, f.name, f.mime_type, f.size_bytes FROM files f
     WHERE f.team_id = ${src.teamId} AND f.thread_id = ${src.threadId} AND f.run_id = ${src.runId}
       AND f.kind = 'upload'
     ORDER BY f.created_at, f.id`);
  return res.rows;
}

export type BuiltCopy =
  | {
      readonly ok: true;
      readonly content: EvalCaseContent;
      readonly digest: string;
      readonly available: EvalCasePreview["available"];
    }
  /** An option names a tool output or attachment this answer doesn't have. */
  | { readonly ok: false; readonly error: "invalid_request" };

/** Builds the copy for `options` (the same input always gives the same content and digest). */
export async function buildCopy(
  tx: KobeTx,
  src: ExchangeSource,
  options: EvalCaseOptions,
): Promise<BuiltCopy> {
  const answer = readAnswer(await answerEntries(tx, src));
  const branch = readBranch(await branchEntries(tx, src));
  const files = await runAttachments(tx, src);
  const toolIds = new Set(answer.tools.map((t) => t.id));
  const fileIds = new Set(files.map((f) => f.id));
  if (
    !options.tool_output_ids.every((id) => toolIds.has(id)) ||
    !options.attachment_ids.every((id) => fileIds.has(id))
  ) {
    return { ok: false, error: "invalid_request" };
  }
  const promptCount = branch.turns.filter((t) => t.role === "user").length;
  const earlierAvailable = Math.min(EVAL_CASE_MAX_EARLIER_EXCHANGES, promptCount);
  const earlier = lastExchanges(
    branch.turns,
    Math.min(options.earlier_exchanges, earlierAvailable),
  );
  const ticked = new Set(options.tool_output_ids);
  let toolCut = false;
  const toolOutputs = answer.tools
    .filter((t) => ticked.has(t.id))
    .map((t) => {
      const c = capText(t.text, EVAL_CASE_TOOL_OUTPUT_MAX_CHARS);
      toolCut ||= c.cut;
      return { tool: t.tool, text: c.text, is_error: t.isError };
    });
  const attached = new Set(options.attachment_ids);
  // App context (KOBE-439) is untrusted and tied to the run's apps: an eval case keeps the text.
  // So is the server's skill line (KOBE-451): the case keeps the member's own text.
  const prompt = capText(
    splitSkillRequest(splitAppContext(src.input).rest).rest,
    EVAL_CASE_TEXT_MAX_CHARS,
  );
  const content: EvalCaseContent = {
    prompt: prompt.text,
    answer: answer.text.text,
    earlier: earlier.turns,
    tool_outputs: toolOutputs,
    attachments: files
      .filter((f) => attached.has(f.id))
      .map((f) => ({
        name: cleanText(f.name),
        mime_type: cleanText(f.mime_type),
        size_bytes: Number(f.size_bytes),
      })),
    reasons: [...src.reasons],
    comment: src.comment === null ? null : cleanText(src.comment),
    truncated:
      prompt.cut ||
      answer.text.cut ||
      answer.offloaded ||
      earlier.cut ||
      toolCut ||
      (options.earlier_exchanges > 0 && branch.offloaded),
  };
  return {
    ok: true,
    content,
    digest: contentDigest(content),
    available: {
      earlier_exchanges: earlierAvailable,
      tool_outputs: answer.tools.map((t) => ({ id: t.id, tool: t.tool, is_error: t.isError })),
      attachments: files.map((f) => ({
        id: f.id,
        name: cleanText(f.name),
        mime_type: cleanText(f.mime_type),
        size_bytes: Number(f.size_bytes),
      })),
    },
  };
}
