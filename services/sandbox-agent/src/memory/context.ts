import {
  MEMORY_INDEX_FILE,
  SYSTEM_PROMPT_MAX_BYTES,
  type MemoryScope,
  type RunMemoryContext,
} from "@kobe/protocol";
import { MEMORY_NOTICE, capBytes, untrustedMemoryBlock } from "../kobe-tools/memory-tools.js";

/**
 * The memory index in the model's context (KOBE-157, memory.ts `run.start.memory`). Indexes are
 * saved text: approved project memory reaches every member's context, so it is fenced as untrusted
 * data, stripped of control characters and capped before it joins the system prompt
 * (pi/system-prompt-file.ts). Topic files are never preloaded; the model reads them with `recall`.
 */
export const INDEX_MAX_BYTES = 12 * 1024;
const SCOPE_ORDER: readonly MemoryScope[] = ["user", "project"];
const MIN_BUDGET_BYTES = 512;

const HEADER = [
  "## Saved memory",
  MEMORY_NOTICE,
  "Use the recall tool to read a topic file or search memory, and the remember tool to save something worth keeping.",
].join("\n");

/** The memory section, or undefined when memory is off, has no enabled scope or holds nothing. */
export function memoryContextText(
  memory: RunMemoryContext | undefined,
  maxBytes = INDEX_MAX_BYTES * SCOPE_ORDER.length + 4096,
): string | undefined {
  if (memory === undefined) return undefined;
  const parts: string[] = [];
  for (const scope of SCOPE_ORDER) {
    if (!memory.scopes.includes(scope)) continue;
    const index = memory.indexes.find((i) => i.scope === scope);
    if (index === undefined || index.content.trim() === "") continue;
    const capped = capBytes(index.content, INDEX_MAX_BYTES);
    parts.push(untrustedMemoryBlock(scope, MEMORY_INDEX_FILE, capped.text));
    if (capped.cut || index.truncated) {
      parts.push(`(the ${scope} index is truncated; recall ${MEMORY_INDEX_FILE} for the rest)`);
    }
  }
  if (parts.length === 0) return undefined;
  const text = [HEADER, ...parts].join("\n");
  // Never cut through a fence: what does not fit is left out whole.
  return Buffer.byteLength(text) > maxBytes ? undefined : text;
}

/** The agent's own system prompt with the memory section appended, within the prompt limit. */
export function withMemoryContext(
  prompt: string | undefined,
  memory: RunMemoryContext | undefined,
): string | undefined {
  const room = SYSTEM_PROMPT_MAX_BYTES - Buffer.byteLength(prompt ?? "") - 2;
  const section = room < MIN_BUDGET_BYTES ? undefined : memoryContextText(memory, room);
  if (section === undefined) return prompt;
  return prompt === undefined || prompt === "" ? section : `${prompt}\n\n${section}`;
}
