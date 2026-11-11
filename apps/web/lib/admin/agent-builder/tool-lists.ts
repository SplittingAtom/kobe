import { splitLines, type FormState } from "./form-model";

/**
 * The creator's Allowed / Denied tool boxes (KOBE-476 AC4) over the agent file's own fields:
 * Allowed is `tools.allow`, Denied is `tools.deny`. Choosing a connector writes each of its tools
 * into `tools.allow` explicitly, one by one (AC1: Dangerous mode runs only tools named that way);
 * removing it takes them out of both lists. All pure: each returns a new form.
 */

const unique = (list: readonly string[]): string[] => [...new Set(list)];
const join = (list: readonly string[]): string => list.join("\n");

/** Tools in the Denied box: the deny list. */
export function deniedTools(form: FormState): string[] {
  return unique(splitLines(form.toolsDeny));
}

/** Tools in the Allowed box: the allow list, minus anything denied. */
export function allowedTools(form: FormState): string[] {
  const denied = new Set(deniedTools(form));
  return unique(splitLines(form.toolsAllow)).filter((t) => !denied.has(t));
}

/** Moves `tool` to Denied. */
export function denyTool(form: FormState, tool: string): FormState {
  return {
    ...form,
    toolsAllow: join(splitLines(form.toolsAllow).filter((t) => t !== tool)),
    toolsDeny: join(unique([...splitLines(form.toolsDeny), tool])),
  };
}

/** Moves `tool` (or a typed entry) to Allowed: written to the allow list explicitly. */
export function allowTool(form: FormState, tool: string): FormState {
  return {
    ...form,
    toolsAllow: join(unique([...splitLines(form.toolsAllow), tool])),
    toolsDeny: join(splitLines(form.toolsDeny).filter((t) => t !== tool)),
  };
}

/**
 * After the connectors change: the newly chosen connectors' tools join the allow list one by one
 * (not those already denied), and the tools of connectors no longer chosen leave both lists.
 */
export function withConnectorTools(
  form: FormState,
  added: readonly string[],
  removed: readonly string[] = [],
): FormState {
  const gone = new Set(removed);
  const denied = deniedTools(form).filter((t) => !gone.has(t));
  const deniedSet = new Set(denied);
  const allow = splitLines(form.toolsAllow).filter((t) => !gone.has(t));
  return {
    ...form,
    toolsAllow: join(unique([...allow, ...added.filter((t) => !deniedSet.has(t))])),
    toolsDeny: join(denied),
  };
}

/**
 * Keeps Kobe's docs tools on (KOBE-623, spec kobe-admin-mcp KA7): they attach to every run, but an
 * agent that narrows its tools with an allow list only keeps the tools that list names. So while
 * the allow list names anything else, the docs tools are named too (unless denied); once it
 * names nothing else they leave it again, so an empty list keeps meaning "not narrowed".
 */
export function withKobeDocs(form: FormState, docsTools: readonly string[]): FormState {
  if (docsTools.length === 0) return form;
  const docs = new Set(docsTools);
  const allow = splitLines(form.toolsAllow);
  const others = allow.filter((t) => !docs.has(t));
  if (others.length === 0) {
    return allow.length === 0 ? form : { ...form, toolsAllow: "" };
  }
  const denied = new Set(deniedTools(form));
  return {
    ...form,
    toolsAllow: join(unique([...allow, ...docsTools.filter((t) => !denied.has(t))])),
  };
}
