import { splitLines, type FormState } from "./form-model";

/**
 * The creator's Allowed / Denied tool boxes (KOBE-476 AC4) over the agent file's own fields:
 * Denied tools are `tools.deny` entries; allowed connector tools go into `tools.allow` only when
 * the agent already restricts its tools (a non-empty allow list), since a non-empty allow list
 * also cuts off every built-in tool. All pure: each returns a new form.
 */

const unique = (list: readonly string[]): string[] => [...new Set(list)];
const join = (list: readonly string[]): string => list.join("\n");

/** Tools in the Denied box: the deny list. */
export function deniedTools(form: FormState): string[] {
  return unique(splitLines(form.toolsDeny));
}

/** Tools in the Allowed box: typed allow entries, then the chosen connectors' tools, not denied. */
export function allowedTools(form: FormState, connectorTools: readonly string[]): string[] {
  const denied = new Set(deniedTools(form));
  return unique([...splitLines(form.toolsAllow), ...connectorTools]).filter((t) => !denied.has(t));
}

/** Moves `tool` to Denied. */
export function denyTool(form: FormState, tool: string): FormState {
  return {
    ...form,
    toolsAllow: join(splitLines(form.toolsAllow).filter((t) => t !== tool)),
    toolsDeny: join(unique([...splitLines(form.toolsDeny), tool])),
  };
}

/**
 * Moves `tool` back to Allowed. A connector tool joins the allow list only when that list already
 * restricts the agent; any other entry (a typed tool or glob) is written to it.
 */
export function allowTool(
  form: FormState,
  tool: string,
  connectorTools: readonly string[],
): FormState {
  const allow = splitLines(form.toolsAllow);
  const write = allow.length > 0 || !connectorTools.includes(tool);
  return {
    ...form,
    toolsAllow: join(write ? unique([...allow, tool]) : allow),
    toolsDeny: join(splitLines(form.toolsDeny).filter((t) => t !== tool)),
  };
}

/** After the connectors change: a restricting allow list gains their tools (not denied ones). */
export function withConnectorTools(form: FormState, connectorTools: readonly string[]): FormState {
  const allow = splitLines(form.toolsAllow);
  if (allow.length === 0) return form;
  const denied = new Set(deniedTools(form));
  return {
    ...form,
    toolsAllow: join(unique([...allow, ...connectorTools.filter((t) => !denied.has(t))])),
  };
}
