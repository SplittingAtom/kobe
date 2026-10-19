import {
  EVAL_OUTPUT_READ_MAX_BYTES,
  EVAL_READ_MAX_FILES,
  EVAL_READ_MAX_TOTAL_BYTES,
  evalReadResultSchema,
  judgeOutputText,
  type EvalWorkspaceEntry,
  type SkillEvalJudgeOutput,
} from "@kobe/protocol";
import type { SandboxRouter, SandboxTarget } from "../../sandbox-wire/types.js";

/**
 * The matched outputs as the judge sees them (KOBE-326, contract KOBE-324): the sandbox reads
 * them under `eval.read` (O_NOFOLLOW, regular file of the walked size, ≤ 256 KiB each, ≤ 1 MiB in
 * all); here the reply is checked again (untrusted: the same files in the same order, no more
 * bytes than the cap or the file holds, no more than the total in all) and each becomes its text,
 * null for a binary file, or `unread` (refused, skipped, past the first
 * {@link EVAL_READ_MAX_FILES}, or more bytes than its cap): the judge sees those by path and size
 * only, told which. Null when the read failed as a whole. No outputs: no command at all.
 */
export async function judgeOutputs(
  router: Pick<SandboxRouter, "evalRead">,
  target: SandboxTarget,
  threadId: string,
  files: readonly EvalWorkspaceEntry[],
): Promise<SkillEvalJudgeOutput[] | null> {
  if (files.length === 0) return [];
  const asked = files.slice(0, EVAL_READ_MAX_FILES);
  const out = await router.evalRead(target, {
    threadId,
    files: asked.map((f) => ({ path: f.path, size: f.size })),
  });
  if (!out.ok) return null;
  const parsed = evalReadResultSchema.safeParse(out.data);
  if (!parsed.success || parsed.data.files.length !== asked.length) return null;
  const read = parsed.data.files;
  if (read.some((r, i) => r.path !== asked[i]?.path)) return null;
  const bytes = read.map((r) => (r.status === "read" ? Buffer.from(r.data, "base64") : null));
  if (bytes.reduce((n, b) => n + (b?.length ?? 0), 0) > EVAL_READ_MAX_TOTAL_BYTES) return null;
  return files.map((f, i) => {
    const b = bytes[i];
    const unread = { path: f.path, size: f.size, text: null, unread: true };
    if (!b || b.length > Math.min(EVAL_OUTPUT_READ_MAX_BYTES, f.size)) return unread;
    return { path: f.path, size: f.size, text: judgeOutputText(b, b.length < f.size) };
  });
}
