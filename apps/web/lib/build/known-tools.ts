import { BUILTIN_TOOLS } from "@kobe/protocol";

/**
 * Whether this build knows the tool (KOBE-487). The server runs only built-in tools and connector
 * tools (`mcp__<server>__<tool>`) and denies anything else, so a name outside both is one a newer
 * build added: the web may have been redeployed under this page.
 */
export function isKnownToolName(name: string): boolean {
  return Object.hasOwn(BUILTIN_TOOLS, name) || name.startsWith("mcp__");
}
