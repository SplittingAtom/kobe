import { isAlias, isNode, parseDocument, visit } from "yaml";
import type { z } from "zod";
import {
  AGENT_FILE_LIMITS,
  FORBIDDEN_CONTROL,
  agentFrontmatterSchema,
  type AgentDefinition,
  type AgentFileIssue,
  type AgentFileResult,
} from "./schema.js";
import { serializeAgentFile } from "./serialize.js";
import { utf8Length } from "./utf8.js";

const DELIMITER = "---";

const fail = (path: string, message: string): AgentFileResult => ({
  ok: false,
  issues: [{ path, message }],
});

/**
 * Parses an agent markdown file (spec §6.3): `---` YAML frontmatter `---` then the system prompt.
 * Safe on untrusted input: size-limited before parsing; YAML 1.2 core schema only; anchors,
 * aliases, tags and duplicate keys are refused (no alias bombs, no executable tags); the
 * frontmatter must match the strict schema. The result's canonical export re-imports identically.
 */
export function parseAgentFile(source: string): AgentFileResult {
  if (utf8Length(source) > AGENT_FILE_LIMITS.fileBytes) {
    return fail("", `file is too large (max ${AGENT_FILE_LIMITS.fileBytes} bytes)`);
  }
  const text = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (FORBIDDEN_CONTROL.test(text)) {
    return fail("", "file contains a control character (only tab and newline are allowed)");
  }
  const split = splitFrontmatter(text);
  if (!split) {
    return fail(
      "frontmatter",
      "file must start with YAML frontmatter between two lines of `---`",
    );
  }
  if (utf8Length(split.yaml) > AGENT_FILE_LIMITS.frontmatterBytes) {
    return fail(
      "frontmatter",
      `frontmatter is too large (max ${AGENT_FILE_LIMITS.frontmatterBytes} bytes)`,
    );
  }
  const yaml = readYaml(split.yaml);
  if (!yaml.ok) return yaml;
  return validateAgentDefinition({ frontmatter: yaml.value, prompt: split.body });
}

/**
 * Validates a definition given as data (the JSON API's `{ frontmatter, prompt }`) with the same
 * schema, normalization and limits as a file import.
 */
export function validateAgentDefinition(input: unknown): AgentFileResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail("", "definition must be an object with frontmatter and prompt");
  }
  const { frontmatter, prompt, ...rest } = input as Record<string, unknown>;
  const extra = Object.keys(rest);
  if (extra.length > 0) return fail(extra[0] ?? "", "unknown key");
  if (typeof prompt !== "string") return fail("prompt", "prompt must be a string");
  if (FORBIDDEN_CONTROL.test(prompt)) {
    return fail("prompt", "prompt contains a control character (only tab and newline are allowed)");
  }
  const parsed = agentFrontmatterSchema.safeParse(frontmatter ?? null);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };

  const definition: AgentDefinition = {
    frontmatter: parsed.data,
    prompt: normalizePrompt(prompt),
  };
  return checkCanonicalSize(definition);
}

/** Leading blank lines and trailing whitespace are not part of the prompt; CRLF becomes LF. */
function normalizePrompt(prompt: string): string {
  return prompt
    .replace(/\r\n?/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .trimEnd();
}

function checkCanonicalSize(definition: AgentDefinition): AgentFileResult {
  if (utf8Length(definition.prompt) > AGENT_FILE_LIMITS.promptBytes) {
    return fail("prompt", `prompt is too large (max ${AGENT_FILE_LIMITS.promptBytes} bytes)`);
  }
  const exported = serializeAgentFile(definition);
  const frontmatterBytes = utf8Length(exported) - utf8Length(definition.prompt);
  if (frontmatterBytes > AGENT_FILE_LIMITS.frontmatterBytes) {
    return fail(
      "frontmatter",
      `frontmatter is too large (max ${AGENT_FILE_LIMITS.frontmatterBytes} bytes)`,
    );
  }
  return { ok: true, definition };
}

function splitFrontmatter(text: string): { yaml: string; body: string } | null {
  const lines = text.split("\n");
  if (lines[0]?.trimEnd() !== DELIMITER) return null;
  const close = lines.findIndex((l, i) => i > 0 && l.trimEnd() === DELIMITER);
  if (close < 0) return null;
  return { yaml: lines.slice(1, close).join("\n"), body: lines.slice(close + 1).join("\n") };
}

type YamlResult = { ok: true; value: unknown } | { ok: false; issues: AgentFileIssue[] };

function readYaml(source: string): YamlResult {
  const doc = parseDocument(source, {
    version: "1.2",
    schema: "core",
    merge: false,
    uniqueKeys: true,
    stringKeys: true,
    strict: true,
    prettyErrors: false,
  });
  const problems = [...doc.errors, ...doc.warnings];
  if (problems.length > 0) {
    return {
      ok: false,
      issues: problems.map((e) => ({
        path: "frontmatter",
        message: `invalid YAML: ${e.message.split("\n")[0] ?? e.code}`,
      })),
    };
  }
  let unsafe: string | undefined;
  visit(doc, (_key, node) => {
    if (isAlias(node)) unsafe = "aliases are not allowed";
    else if (isNode(node) && node.anchor) unsafe = "anchors are not allowed";
    else if (isNode(node) && node.tag) unsafe = "explicit tags are not allowed";
    return unsafe ? visit.BREAK : undefined;
  });
  if (unsafe) return { ok: false, issues: [{ path: "frontmatter", message: unsafe }] };
  try {
    return { ok: true, value: doc.toJS({ maxAliasCount: 0 }) };
  } catch {
    return { ok: false, issues: [{ path: "frontmatter", message: "invalid YAML" }] };
  }
}

function zodIssues(error: z.ZodError): AgentFileIssue[] {
  return error.issues.map((issue) => ({
    path: ["frontmatter", ...issue.path.map(String)].join("."),
    message:
      issue.code === "unrecognized_keys"
        ? `unknown key ${issue.keys.map((k) => `\`${k}\``).join(", ")}`
        : issue.message,
  }));
}
