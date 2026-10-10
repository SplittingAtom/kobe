import {
  MEMORY_INDEX_FILE,
  SYSTEM_PROMPT_MAX_BYTES,
  type MemoryIndex,
  type MemoryScope,
  type RunProjectContext,
  type RunMemoryContext,
} from "@kobe/protocol";
import {
  beginMarker,
  capBytes,
  memoryNotice,
  newNonce,
  untrustedMemoryBlock,
} from "../kobe-tools/memory-fence.js";
import type { MemoryFileContent } from "./context-file.js";
import { projectContextText } from "./project-context.js";

/**
 * The memory index in the model's context (KOBE-157, memory.ts `run.start.memory`). Indexes are
 * saved text: approved project memory reaches every member's context, so each is fenced as
 * untrusted data (random nonce per run, see kobe-tools/memory-fence.ts), sanitised, labelled with
 * its scope and provenance, and capped. The section reaches the model through the per-run memory
 * file and the kobe-tools extension, not the launch: a changed index never restarts Pi. Topic
 * files are never preloaded; the model reads them with `recall`.
 */
export const INDEX_MAX_BYTES = 12 * 1024;
const SCOPE_ORDER: readonly MemoryScope[] = ["user", "project"];

const HEADER = "## Saved memory";
const USAGE =
  "Use the recall tool to read a topic file or search memory, and the remember tool to save something worth keeping.";

function provenanceOf(index: MemoryIndex): string | undefined {
  if (index.written_by === undefined) return undefined;
  if (index.written_by === "person") return "last edited by a person";
  // Agent writes into shared project memory only happen after a member approved them.
  return index.scope === "project"
    ? "last written by the agent and approved by a project member"
    : "last written by the agent";
}

/** The memory section, or undefined when memory is off, has no enabled scope or holds nothing. */
export function memoryContextText(
  memory: RunMemoryContext | undefined,
  nonce: string = newNonce(),
): string | undefined {
  if (memory === undefined) return undefined;
  const parts: string[] = [];
  for (const scope of SCOPE_ORDER) {
    if (!memory.scopes.includes(scope)) continue;
    const index = memory.indexes.find((i) => i.scope === scope);
    if (index === undefined || index.content.trim() === "") continue;
    const capped = capBytes(index.content, INDEX_MAX_BYTES);
    const note =
      capped.cut || index.truncated
        ? `(the ${scope} index is truncated; recall ${MEMORY_INDEX_FILE} for the rest)`
        : undefined;
    parts.push(
      untrustedMemoryBlock(
        nonce,
        { scope, path: MEMORY_INDEX_FILE, provenance: provenanceOf(index) },
        capped.text,
        note,
      ),
    );
  }
  if (parts.length === 0) return undefined;
  const text = [HEADER, memoryNotice(nonce), USAGE, ...parts].join("\n");
  // Never cut through a fence: a section that would not fit is left out whole.
  return Buffer.byteLength(text) > SYSTEM_PROMPT_MAX_BYTES ? undefined : text;
}

/** What the extension gets for this run: tools only when some scope is enabled; text only with content. */
export function memoryRunFileContent(
  memory: RunMemoryContext | undefined,
  nonce?: string,
  project?: RunProjectContext,
): MemoryFileContent {
  const tools = memory !== undefined && memory.scopes.length > 0;
  return {
    tools,
    text: tools ? (memoryContextText(memory, nonce) ?? "") : "",
    project: projectContextText(project) ?? "",
  };
}

export { beginMarker };
