import type { PinnedTool } from "@kobe/db";

/**
 * MCP Apps visibility (KOBE-435, spec MA6): a tool's pinned `_meta.ui.visibility`, default
 * `["model", "app"]` (stored only when it differs). Without `"model"` the tool is never offered
 * to Pi (catalog, the proxy's `tools/list`) and its calls are refused; without `"app"` no app
 * may call it (MA-4).
 */
type Visible = Pick<PinnedTool, "ui">;

export const modelVisible = (tool: Visible): boolean =>
  tool.ui?.visibility?.includes("model") ?? true;

export const appVisible = (tool: Visible): boolean => tool.ui?.visibility?.includes("app") ?? true;
