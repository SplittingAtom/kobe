import { createHash } from "node:crypto";
import { ARTIFACT_TOOLS, canonicalJson, type ArtifactToolName } from "@kobe/protocol";

/**
 * The artifact tool calls this connection's policy checks allowed (D-3 of KOBE-55). At allow time
 * the SHA-256 of `canonicalJson(input)` is recorded under (run, tool call); `artifact.put` is
 * accepted only for a call recorded here, for the same tool and the same input hash. The first
 * allowed input of a tool call wins: a later allow of the same id with other input does not
 * replace it. Entries stay after use (a repeated `artifact.put` is idempotent in the database) and
 * are bounded; an evicted entry makes a late `artifact.put` fail closed.
 */

export type AllowedVerdict = "ok" | "not_allowed" | "input_mismatch";

interface Allowed {
  readonly tool: ArtifactToolName;
  readonly hash: string;
}

export const ALLOWED_MAX = 4096;

export function isArtifactTool(tool: string): tool is ArtifactToolName {
  return (ARTIFACT_TOOLS as readonly string[]).includes(tool);
}

/** SHA-256 (hex) of the canonical JSON of `input`, or undefined when it has no canonical form. */
export function inputHash(input: unknown): string | undefined {
  try {
    return createHash("sha256").update(canonicalJson(input), "utf8").digest("hex");
  } catch {
    return undefined;
  }
}

export class AllowedArtifactCalls {
  readonly #calls = new Map<string, Allowed>();

  #key(runId: string, toolCallId: string): string {
    return JSON.stringify([runId, toolCallId]);
  }

  /** Records an allowed call; ignores other tools and inputs without a canonical form. */
  record(runId: string, toolCallId: string, tool: string, input: unknown): void {
    if (!isArtifactTool(tool)) return;
    const hash = inputHash(input);
    if (hash === undefined) return;
    const key = this.#key(runId, toolCallId);
    if (this.#calls.has(key)) return;
    if (this.#calls.size >= ALLOWED_MAX) {
      const oldest = this.#calls.keys().next();
      if (!oldest.done) this.#calls.delete(oldest.value);
    }
    this.#calls.set(key, { tool, hash });
  }

  check(runId: string, toolCallId: string, tool: string, input: unknown): AllowedVerdict {
    const allowed = this.#calls.get(this.#key(runId, toolCallId));
    if (allowed?.tool !== tool) return "not_allowed";
    return allowed.hash === inputHash(input) ? "ok" : "input_mismatch";
  }
}
