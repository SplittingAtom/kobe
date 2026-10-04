import {
  APPROVAL_MODES,
  agentWarnings,
  validateAgentDefinition,
  type AgentDefinition,
  type ApprovalMode,
} from "@kobe/agent-file";

/** The builder's form state: plain strings (one entry per line for lists), never the wire shape. */
export interface FormState {
  readonly name: string;
  readonly role: string;
  readonly description: string;
  readonly icon: string;
  readonly model: string;
  readonly approvalMode: "" | ApprovalMode;
  readonly skills: string;
  readonly skillsExclusive: boolean;
  readonly connectors: string;
  readonly toolsAllow: string;
  readonly toolsDeny: string;
  readonly starters: string;
}

export const EMPTY_FORM: FormState = {
  name: "",
  role: "",
  description: "",
  icon: "",
  model: "",
  approvalMode: "",
  skills: "",
  skillsExclusive: false,
  connectors: "",
  toolsAllow: "",
  toolsDeny: "",
  starters: "",
};

export type FieldKey = keyof FormState | "prompt" | "slug" | "form";
export type FieldErrors = Readonly<Partial<Record<FieldKey, readonly string[]>>>;

export type Validation =
  | { readonly ok: true; readonly definition: AgentDefinition; readonly warnings: string[] }
  | { readonly ok: false; readonly errors: FieldErrors };

/** One entry per non-blank line, trimmed. */
export const splitLines = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");

const joinLines = (list: unknown): string =>
  Array.isArray(list) ? list.filter((x): x is string => typeof x === "string").join("\n") : "";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The frontmatter object the API takes; empty fields are left out (schema: optional, not blank). */
export function toFrontmatter(form: FormState): Record<string, unknown> {
  const out: Record<string, unknown> = { name: form.name };
  const put = (key: string, value: string) => {
    if (value.trim() !== "") out[key] = value;
  };
  put("role", form.role);
  put("description", form.description);
  put("icon", form.icon);
  put("model", form.model);
  const skills = splitLines(form.skills);
  if (form.skillsExclusive) out.skills = { exclusive: skills };
  else if (skills.length > 0) out.skills = skills;
  const connectors = splitLines(form.connectors);
  if (connectors.length > 0) out.connectors = connectors;
  const allow = splitLines(form.toolsAllow);
  const deny = splitLines(form.toolsDeny);
  if (allow.length > 0 || deny.length > 0) {
    out.tools = {
      ...(allow.length > 0 ? { allow } : {}),
      ...(deny.length > 0 ? { deny } : {}),
    };
  }
  if (form.approvalMode !== "") out.approval_mode = form.approvalMode;
  const starters = splitLines(form.starters);
  if (starters.length > 0) out.starters = starters;
  return out;
}

/** Form state for a stored frontmatter (the server only stores validated documents). */
export function fromFrontmatter(frontmatter: Record<string, unknown>): FormState {
  const skills = frontmatter.skills;
  const exclusive =
    typeof skills === "object" && skills !== null && !Array.isArray(skills)
      ? (skills as { exclusive?: unknown }).exclusive
      : undefined;
  const tools = (frontmatter.tools ?? {}) as { allow?: unknown; deny?: unknown };
  const mode = frontmatter.approval_mode;
  return {
    name: str(frontmatter.name),
    role: str(frontmatter.role),
    description: str(frontmatter.description),
    icon: str(frontmatter.icon),
    model: str(frontmatter.model),
    approvalMode: APPROVAL_MODES.find((m) => m === mode) ?? "",
    skills: joinLines(exclusive ?? skills),
    skillsExclusive: exclusive !== undefined,
    connectors: joinLines(frontmatter.connectors),
    toolsAllow: joinLines(tools.allow),
    toolsDeny: joinLines(tools.deny),
    starters: joinLines(frontmatter.starters),
  };
}

const PATH_FIELDS: Readonly<Record<string, FieldKey>> = {
  name: "name",
  role: "role",
  description: "description",
  icon: "icon",
  model: "model",
  skills: "skills",
  connectors: "connectors",
  approval_mode: "approvalMode",
  starters: "starters",
  "tools.allow": "toolsAllow",
  "tools.deny": "toolsDeny",
};

/** Maps an agent-file issue path (`frontmatter.skills.exclusive.1`) to a form field and entry. */
function fieldOf(path: string): { field: FieldKey; entry: number | null } {
  if (path === "prompt") return { field: "prompt", entry: null };
  const parts = path.split(".");
  if (parts[0] !== "frontmatter") return { field: "form", entry: null };
  const rest = parts.slice(1).filter((p) => p !== "exclusive");
  const last = rest.at(-1);
  const index = last !== undefined && /^\d+$/.test(last) ? Number(last) : null;
  const key = (index === null ? rest : rest.slice(0, -1)).join(".");
  return { field: PATH_FIELDS[key] ?? "form", entry: index };
}

/** Validates with the same schema the server applies (`@kobe/agent-file`), per form field. */
export function validateForm(form: FormState, prompt: string): Validation {
  const result = validateAgentDefinition({ frontmatter: toFrontmatter(form), prompt });
  if (result.ok) {
    return {
      ok: true,
      definition: result.definition,
      warnings: agentWarnings(result.definition.frontmatter).map((w) => w.message),
    };
  }
  const errors: Partial<Record<FieldKey, string[]>> = {};
  for (const issue of result.issues) {
    const { field, entry } = fieldOf(issue.path);
    const message = entry === null ? issue.message : `Entry ${entry + 1} ${issue.message}`;
    errors[field] = [...(errors[field] ?? []), message];
  }
  return { ok: false, errors };
}
