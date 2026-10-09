/**
 * The slice of `@earendil-works/pi-coding-agent` (Apache-2.0 / MIT, the pinned Pi 1.0.0) that
 * kobe-exec uses, declared here so the extension compiles without the package in this workspace:
 * Pi's extension loader (jiti) resolves the specifier to its own copy at runtime (verified 1.0.0,
 * `core/extensions/loader.js` aliases). Shapes follow Pi's `core/tools/*.d.ts` and
 * `core/extensions/types.d.ts`; `kobe-exec.real-pi.test.ts` proves them against the real package.
 */
declare module "@earendil-works/pi-coding-agent" {
  export interface ToolContext {
    readonly cwd?: string;
    readonly [key: string]: unknown;
  }

  export interface ToolDefinition {
    readonly name: string;
    readonly [key: string]: unknown;
    execute(
      toolCallId: string,
      params: never,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: ToolContext | undefined,
    ): Promise<unknown>;
  }

  export interface ToolOptions<Operations> {
    readonly operations?: Operations;
  }

  export interface ToolResult {
    readonly content: readonly { readonly type: "text"; readonly text: string }[];
    readonly details: unknown;
  }

  export interface Truncation {
    readonly content: string;
    readonly truncated: boolean;
  }

  export function createBashToolDefinition(cwd: string, options?: ToolOptions<unknown>): ToolDefinition;
  export function createReadToolDefinition(cwd: string, options?: ToolOptions<unknown>): ToolDefinition;
  export function createWriteToolDefinition(cwd: string, options?: ToolOptions<unknown>): ToolDefinition;
  export function createEditToolDefinition(cwd: string, options?: ToolOptions<unknown>): ToolDefinition;
  export function createLsToolDefinition(cwd: string, options?: ToolOptions<unknown>): ToolDefinition;
  export function createGrepToolDefinition(cwd: string, options?: ToolOptions<unknown>): ToolDefinition;
  export function createFindToolDefinition(cwd: string, options?: ToolOptions<unknown>): ToolDefinition;
  export function truncateHead(content: string, options?: { maxLines?: number }): Truncation;
  export function truncateLine(
    line: string,
    maxChars?: number,
  ): { text: string; wasTruncated: boolean };
  export function formatSize(bytes: number): string;
  export const DEFAULT_MAX_BYTES: number;
  export function detectSupportedImageMimeTypeFromFile(filePath: string): Promise<string | null>;
}
