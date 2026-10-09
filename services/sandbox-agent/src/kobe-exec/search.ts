import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ExecTransport } from "./client.js";
import { pathExists, readFileBuffer, toError } from "./remote-ops.js";
import { OP_EXEC, OP_STAT } from "./protocol.js";

/**
 * Pi's `grep` and `find` tools with ripgrep / fd run by the executor. Pi's own versions spawn `rg`
 * and `fd` from Pi's process (`core/tools/grep.js`, `find.js`: custom `operations` cover only
 * `isDirectory` / `readFile` / `glob`, not the spawn, and with a custom `glob` find formats its
 * output differently), so these two re-implement the tools' `execute` from the same source, with
 * the same arguments, parsing, limits and messages (verified Pi 1.0.0). What Pi exports
 * (truncation helpers, size formatting) is reused through {@link SearchHelpers}.
 */
export interface SearchHelpers {
  truncateHead(
    content: string,
    options?: { maxLines?: number },
  ): { content: string; truncated: boolean };
  truncateLine(line: string, maxChars?: number): { text: string; wasTruncated: boolean };
  formatSize(bytes: number): string;
  readonly DEFAULT_MAX_BYTES: number;
}

export interface ToolResultLike {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly details: unknown;
}

/** A function, so TypeScript does not remember an earlier check across the awaits. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** GREP_MAX_LINE_LENGTH in Pi's core/tools/truncate.js. */
const GREP_MAX_LINE_LENGTH = 500;
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_FIND_LIMIT = 1000;
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Pi's `resolveToCwd`: unicode spaces, leading `@`, `~`, `file://`, then against the cwd. */
export function resolveToCwd(input: string, cwd: string, homeDir?: string): string {
  let value = input.replace(UNICODE_SPACES, " ");
  if (value.startsWith("@")) value = value.slice(1);
  const home = homeDir ?? process.env.HOME ?? homedir();
  if (value === "~") value = home;
  else if (value.startsWith("~/")) value = path.join(home, value.slice(2));
  if (/^file:\/\//.test(value)) value = fileURLToPath(value);
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value);
}

/** Lines of a stream of chunks, as Node's readline gives them (split on LF, CR before it kept). */
function lineSplitter(onLine: (line: string) => void): { push(chunk: Buffer): void; end(): void } {
  let pending = "";
  return {
    push(chunk) {
      pending += chunk.toString("utf-8");
      for (let lf = pending.indexOf("\n"); lf !== -1; lf = pending.indexOf("\n")) {
        const line = pending.slice(0, lf);
        pending = pending.slice(lf + 1);
        onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      }
    },
    end() {
      if (pending !== "") onLine(pending);
      pending = "";
    },
  };
}

interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

interface RgMatch {
  filePath: string;
  lineNumber: number;
  lineText: string | undefined;
}

export async function executeGrep(
  transport: ExecTransport,
  helpers: SearchHelpers,
  input: GrepInput,
  cwd: string,
  signal: AbortSignal | undefined,
  homeDir?: string,
): Promise<ToolResultLike> {
  if (isAborted(signal)) throw new Error("Operation aborted");
  const searchPath = resolveToCwd(input.path || ".", cwd, homeDir);
  const stat = await transport.request({ op: OP_STAT, path: searchPath });
  if (!stat.ok) {
    if (stat.error.code === "unavailable") throw toError(stat);
    throw new Error(`Path not found: ${searchPath}`);
  }
  const isDirectory = stat.fields.kind === "dir";
  const contextValue = input.context && input.context > 0 ? input.context : 0;
  const effectiveLimit = Math.max(1, input.limit ?? DEFAULT_GREP_LIMIT);
  const formatPath = (filePath: string): string => {
    if (isDirectory) {
      const relative = path.relative(searchPath, filePath);
      if (relative && !relative.startsWith("..")) return relative.replace(/\\/g, "/");
    }
    return path.basename(filePath);
  };
  const fileCache = new Map<string, string[]>();
  const getFileLines = async (filePath: string): Promise<string[]> => {
    let lines = fileCache.get(filePath);
    if (!lines) {
      try {
        const content = (await readFileBuffer(transport, filePath)).toString("utf-8");
        lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      } catch {
        lines = [];
      }
      fileCache.set(filePath, lines);
    }
    return lines;
  };

  const args = ["rg", "--json", "--line-number", "--color=never", "--hidden"];
  if (input.ignoreCase) args.push("--ignore-case");
  if (input.literal) args.push("--fixed-strings");
  if (input.glob) args.push("--glob", input.glob);
  args.push("--", input.pattern, searchPath);

  const matches: RgMatch[] = [];
  let matchCount = 0;
  let matchLimitReached = false;
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const lines = lineSplitter((line) => {
    if (!line.trim() || matchCount >= effectiveLimit) return;
    let event: {
      type?: string;
      data?: { path?: { text?: string }; line_number?: unknown; lines?: { text?: string } };
    };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      return;
    }
    if (event.type !== "match") return;
    matchCount += 1;
    const filePath = event.data?.path?.text;
    const lineNumber = event.data?.line_number;
    if (filePath && typeof lineNumber === "number") {
      matches.push({ filePath, lineNumber, lineText: event.data?.lines?.text });
    }
    if (matchCount >= effectiveLimit) {
      matchLimitReached = true;
      stop.abort();
    }
  });
  let stderr = "";
  let outcome;
  try {
    outcome = await transport.request(
      { op: OP_EXEC, cwd, argv: args },
      {
        signal: stop.signal,
        onStream: (stream, data) => {
          if (stream === "stdout") lines.push(data);
          else stderr += data.toString();
        },
      },
    );
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  lines.end();
  if (isAborted(signal)) throw new Error("Operation aborted");
  if (!outcome.ok) {
    if (outcome.error.code === "aborted" && matchLimitReached) {
      // stopped by us once the limit was reached: not an error
    } else if (outcome.error.code === "spawn_failed") {
      throw new Error(`Failed to run ripgrep: ${outcome.error.message}`);
    } else {
      throw toError(outcome);
    }
  } else {
    const code = outcome.fields.exit_code;
    if (!matchLimitReached && code !== 0 && code !== 1) {
      throw new Error(stderr.trim() || `ripgrep exited with code ${String(code)}`);
    }
  }
  if (matchCount === 0) {
    return { content: [{ type: "text", text: "No matches found" }], details: undefined };
  }

  let linesTruncated = false;
  const formatBlock = async (filePath: string, lineNumber: number): Promise<string[]> => {
    const relativePath = formatPath(filePath);
    const fileLines = await getFileLines(filePath);
    if (!fileLines.length) return [`${relativePath}:${lineNumber}: (unable to read file)`];
    const block: string[] = [];
    const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
    const end =
      contextValue > 0 ? Math.min(fileLines.length, lineNumber + contextValue) : lineNumber;
    for (let current = start; current <= end; current++) {
      const sanitized = (fileLines[current - 1] ?? "").replace(/\r/g, "");
      const { text, wasTruncated } = helpers.truncateLine(sanitized, GREP_MAX_LINE_LENGTH);
      if (wasTruncated) linesTruncated = true;
      block.push(
        current === lineNumber
          ? `${relativePath}:${current}: ${text}`
          : `${relativePath}-${current}- ${text}`,
      );
    }
    return block;
  };
  const outputLines: string[] = [];
  for (const match of matches) {
    if (contextValue === 0 && match.lineText !== undefined) {
      const sanitized = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
      const { text, wasTruncated } = helpers.truncateLine(sanitized, GREP_MAX_LINE_LENGTH);
      if (wasTruncated) linesTruncated = true;
      outputLines.push(`${formatPath(match.filePath)}:${match.lineNumber}: ${text}`);
    } else {
      outputLines.push(...(await formatBlock(match.filePath, match.lineNumber)));
    }
  }
  const truncation = helpers.truncateHead(outputLines.join("\n"), {
    maxLines: Number.MAX_SAFE_INTEGER,
  });
  let output = truncation.content;
  const details: Record<string, unknown> = {};
  const notices: string[] = [];
  if (matchLimitReached) {
    notices.push(
      `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
    );
    details.matchLimitReached = effectiveLimit;
  }
  if (truncation.truncated) {
    notices.push(`${helpers.formatSize(helpers.DEFAULT_MAX_BYTES)} limit reached`);
    details.truncation = truncation;
  }
  if (linesTruncated) {
    notices.push(
      `Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
    );
    details.linesTruncated = true;
  }
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
  return {
    content: [{ type: "text", text: output }],
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}

interface FindInput {
  pattern: string;
  path?: string;
  limit?: number;
}

/** Pi's `relativizeFindResultPath` (posix only: the sandbox is Linux). */
export function relativizeFindResultPath(resultPath: string, searchPath: string): string {
  const hadTrailingSeparator = resultPath.endsWith("/");
  const relativePath = path.isAbsolute(resultPath)
    ? path.relative(searchPath, resultPath)
    : resultPath;
  return hadTrailingSeparator && !relativePath.endsWith("/") ? `${relativePath}/` : relativePath;
}

export async function executeFind(
  transport: ExecTransport,
  helpers: SearchHelpers,
  input: FindInput,
  cwd: string,
  signal: AbortSignal | undefined,
  homeDir?: string,
): Promise<ToolResultLike> {
  if (isAborted(signal)) throw new Error("Operation aborted");
  const searchPath = resolveToCwd(input.path || ".", cwd, homeDir);
  const effectiveLimit = input.limit ?? DEFAULT_FIND_LIMIT;
  // Inside a git repository fd keeps its git-aware default; elsewhere --no-require-git.
  let insideGitRepo = false;
  for (let current = searchPath; ;) {
    if (await pathExists(transport, path.join(current, ".git"))) {
      insideGitRepo = true;
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const args = ["--glob", "--color=never", "--hidden"];
  if (!insideGitRepo) args.push("--no-require-git");
  args.push("--max-results", String(effectiveLimit));
  let effectivePattern = input.pattern;
  if (input.pattern.includes("/")) {
    args.push("--full-path");
    if (
      !input.pattern.startsWith("/") &&
      !input.pattern.startsWith("**/") &&
      input.pattern !== "**"
    ) {
      effectivePattern = `**/${input.pattern}`;
    }
  }
  args.push("--", effectivePattern, searchPath);

  const found: string[] = [];
  let stderr = "";
  const lines = lineSplitter((line) => void found.push(line));
  const run = async (program: string) => {
    found.length = 0;
    stderr = "";
    return transport.request(
      { op: OP_EXEC, cwd, argv: [program, ...args] },
      {
        signal,
        onStream: (stream, data) => {
          if (stream === "stdout") lines.push(data);
          else stderr += data.toString();
        },
      },
    );
  };
  // Debian ships fd as `fdfind`.
  let outcome = await run("fd");
  if (!outcome.ok && outcome.error.code === "spawn_failed") outcome = await run("fdfind");
  lines.end();
  if (isAborted(signal)) throw new Error("Operation aborted");
  if (!outcome.ok) {
    if (outcome.error.code === "aborted") throw new Error("Operation aborted");
    if (outcome.error.code === "spawn_failed")
      throw new Error(`Failed to run fd: ${outcome.error.message}`);
    throw toError(outcome);
  }
  const output = found.join("\n");
  const code = outcome.fields.exit_code;
  if (code !== 0 && !output)
    throw new Error(stderr.trim() || `fd exited with code ${String(code)}`);
  if (!output) {
    return {
      content: [{ type: "text", text: "No files found matching pattern" }],
      details: undefined,
    };
  }
  const relativized: string[] = [];
  for (const rawLine of found) {
    const line = rawLine.replace(/\r$/, "").trim();
    if (!line) continue;
    relativized.push(relativizeFindResultPath(line, searchPath));
  }
  const resultLimitReached = relativized.length >= effectiveLimit;
  const truncation = helpers.truncateHead(relativized.join("\n"), {
    maxLines: Number.MAX_SAFE_INTEGER,
  });
  let resultOutput = truncation.content;
  const details: Record<string, unknown> = {};
  const notices: string[] = [];
  if (resultLimitReached) {
    notices.push(
      `${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
    );
    details.resultLimitReached = effectiveLimit;
  }
  if (truncation.truncated) {
    notices.push(`${helpers.formatSize(helpers.DEFAULT_MAX_BYTES)} limit reached`);
    details.truncation = truncation;
  }
  if (notices.length > 0) resultOutput += `\n\n[${notices.join(". ")}]`;
  return {
    content: [{ type: "text", text: resultOutput }],
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}
