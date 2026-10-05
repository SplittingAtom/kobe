import { posix } from "node:path";
import { z } from "zod";
import { artifactToolInputSchema, type JsonObject, type ToolDescriptor } from "@kobe/protocol";

/**
 * Input checks for built-in tools before any rule is evaluated (review KOBE-35 HIGH 1).
 *
 * 1. **Strict schemas.** Each Pi 1.0.0 built-in's parameters, VERIFIED against
 *    `@earendil-works/pi-coding-agent@1.0.0` (`dist/core/tools/*.js`, `extensions/codemode`,
 *    `extensions/tool-search`). Unknown or alias keys are denied, so a rule on `/path` can't be
 *    dodged with a key Pi would also accept (e.g. edit's legacy top-level `oldText`/`newText`,
 *    which Pi's `prepareArguments` folds into `edits[]`).
 * 2. **Canonical paths.** File tools' `path` is resolved the way Pi resolves it against the
 *    sandbox cwd (`/workspace`): relative → absolute, `//`, `.`, `..` collapsed. Inputs Pi would
 *    rewrite in ways a glob can't see (`~`, `@` prefix, `file://`, Unicode spaces) are denied.
 *    Rules match the canonical path; the call itself runs with the original input (the signed
 *    one). Omitted optional paths (ls, grep, find) match as the cwd.
 *
 * kobe-tools: `create_artifact` / `update_artifact` use the published strict schemas
 * (`artifactToolInputSchema`, KOBE-127: kinds, title and 512 KiB content caps, `language` only for
 * code). The others (`share_file`, `remember`, …) have no published schema yet (KOBE-54/56): any
 * JSON object passes, except that a string `path` is canonicalised too.
 * MCP tools are validated by the MCP proxy against their pinned schema (KOBE-58/59).
 */

/** Pi's working directory in the sandbox (images/sandbox/Dockerfile `WORKDIR /workspace`). */
export const SANDBOX_CWD = "/workspace";

const num = z.number();
const str = z.string();

export const BUILTIN_INPUT_SCHEMAS: Readonly<Record<string, z.ZodType<unknown>>> = {
  read: z.strictObject({ path: str, offset: num.optional(), limit: num.optional() }),
  write: z.strictObject({ path: str, content: str }),
  edit: z.strictObject({
    path: str,
    edits: z.array(z.strictObject({ oldText: str, newText: str })),
  }),
  bash: z.strictObject({ command: str, timeout: num.optional() }),
  powershell: z.strictObject({ command: str, timeout: num.optional() }),
  ls: z.strictObject({ path: str.optional(), limit: num.optional() }),
  grep: z.strictObject({
    pattern: str,
    path: str.optional(),
    glob: str.optional(),
    ignoreCase: z.boolean().optional(),
    literal: z.boolean().optional(),
    context: num.optional(),
    limit: num.optional(),
  }),
  find: z.strictObject({ pattern: str, path: str.optional(), limit: num.optional() }),
  codemode: z.strictObject({ code: str }),
  tool_search: z.strictObject({ query: str, limit: num.optional() }),
  create_artifact: artifactToolInputSchema.create_artifact,
  update_artifact: artifactToolInputSchema.update_artifact,
};

/** Built-ins whose `path` is a filesystem path, and whether an omitted path means the cwd. */
const PATH_TOOLS: Readonly<Record<string, { readonly defaultsToCwd: boolean }>> = {
  read: { defaultsToCwd: false },
  write: { defaultsToCwd: false },
  edit: { defaultsToCwd: false },
  ls: { defaultsToCwd: true },
  grep: { defaultsToCwd: true },
  find: { defaultsToCwd: true },
  share_file: { defaultsToCwd: false },
};

// Characters Pi rewrites in paths (utils/paths.js UNICODE_SPACES).
const PI_REWRITTEN_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/u;

/** The canonical absolute path Pi would open, or undefined if Pi would rewrite it opaquely. */
export function canonicalPath(path: string): string | undefined {
  if (path === "" || path.startsWith("@") || path.startsWith("~") || /^file:/i.test(path)) {
    return undefined;
  }
  if (PI_REWRITTEN_SPACES.test(path)) return undefined;
  return posix.resolve(SANDBOX_CWD, path);
}

export type PreparedInput =
  | { readonly ok: true; readonly view: JsonObject }
  | { readonly ok: false; readonly message: string };

/**
 * Validates a built-in's input and returns the view rules match against (canonical paths).
 * Non-built-ins pass through unchanged.
 */
export function prepareInput(tool: ToolDescriptor, input: JsonObject): PreparedInput {
  if (tool.source === "mcp") return { ok: true, view: input };
  const schema = Object.hasOwn(BUILTIN_INPUT_SCHEMAS, tool.name)
    ? BUILTIN_INPUT_SCHEMAS[tool.name]
    : undefined;
  if (schema && !schema.safeParse(input).success) {
    return { ok: false, message: `The input doesn't match ${tool.name}'s parameters.` };
  }
  const pathTool = Object.hasOwn(PATH_TOOLS, tool.name) ? PATH_TOOLS[tool.name] : undefined;
  if (!pathTool) return { ok: true, view: input };
  const raw = input.path;
  if (raw === undefined) {
    return pathTool.defaultsToCwd
      ? { ok: true, view: { ...input, path: SANDBOX_CWD } }
      : { ok: true, view: input };
  }
  if (typeof raw !== "string") return { ok: true, view: input };
  const path = canonicalPath(raw);
  if (path === undefined) {
    return {
      ok: false,
      message: `${tool.name} was given a path the policy can't check (~, @, file:, or special spaces); use a plain path.`,
    };
  }
  return { ok: true, view: { ...input, path } };
}
