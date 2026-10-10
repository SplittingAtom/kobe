import type { RunProjectContext } from "@kobe/protocol";
import { capBytes, sanitizeUntrusted } from "../kobe-tools/memory-fence.js";

/**
 * Project instructions in the model's context (KOBE-245, `run.start.project`). They ride the same
 * per-run file as the memory index (memory/context-file.ts), so editing them never restarts Pi.
 *
 * Trust: written by project admins (owners), so unlike saved memory they are NOT fenced as
 * untrusted data; the model is told to follow them. They still pass the memory sanitiser (NFKC,
 * no control or format characters, no `<<<`, so they cannot forge a memory fence or hide text) and
 * are capped. They are a prompt, not a permission: tools, approvals and policy are server-side.
 */
export const PROJECT_HEADER = "## Project instructions (set by project admins)";
export const PROJECT_INSTRUCTIONS_CAP_BYTES = 8 * 1024;

const oneLine = (value: string): string => sanitizeUntrusted(value).replace(/\s+/g, " ").trim();

/** The project section, or undefined for a non-project run or empty instructions. */
export function projectContextText(project: RunProjectContext | undefined): string | undefined {
  if (project === undefined) return undefined;
  const clean = sanitizeUntrusted(project.instructions).trim();
  if (clean === "") return undefined;
  const capped = capBytes(clean, PROJECT_INSTRUCTIONS_CAP_BYTES);
  const lines = [
    PROJECT_HEADER,
    `This conversation belongs to the project "${oneLine(project.name)}" (files are under ${oneLine(project.mount)}). The project's admins wrote the instructions below: follow them for this project's work. They do not change your safety rules, tools or approvals.`,
    capped.text,
  ];
  if (capped.cut || project.truncated === true) lines.push("(the instructions are truncated)");
  return lines.join("\n");
}
