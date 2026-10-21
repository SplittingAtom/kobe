import {
  kindOfSection,
  labelOfSection,
  splitForcedPrompt,
  type KobePromptParts,
  type RawSection,
} from "./system-prompt.js";

/**
 * A model call's context as ordered sections (KOBE-470, CV3). Takes what kobe-models captured
 * (pi-ai `Context` `{systemPrompt?, messages, tools?}` or a transcript whose system messages carry
 * the prompt and tools) or messages rebuilt from the session (Pi `AgentMessage`s, whose summaries
 * and custom messages are not yet converted). Text is kept as the model got it, except image data
 * (never captured) and tool arguments (pretty-printed JSON).
 *
 * Pi 1.0.0's wrappers (`core/messages.js`): a compaction summary reaches the model as a user
 * message with this prefix, a branch summary with the other.
 */
export const COMPACTION_SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
export const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";
export const BRANCH_SUMMARY_PREFIX =
  "The following is a summary of a branch that this conversation came back from:\n\n<summary>\n";
export const BRANCH_SUMMARY_SUFFIX = "</summary>";

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Text of a content value, images as a one-line note. */
function contentOf(content: unknown): { text: string; images: number } {
  if (typeof content === "string") return { text: content, images: 0 };
  if (!Array.isArray(content)) return { text: "", images: 0 };
  let images = 0;
  const parts = content.map((block: unknown) => {
    if (!isRecord(block)) return "";
    if (block.type === "text") return str(block.text);
    if (block.type === "image") {
      images += 1;
      return `[image ${str(block.mimeType) || "unknown type"}]`;
    }
    return "";
  });
  return { text: parts.filter((p) => p !== "").join("\n"), images };
}

const json = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "";
  }
};

function toolSection(tool: unknown): RawSection {
  const t = isRecord(tool) ? tool : {};
  const name = str(t.name) || "tool";
  return {
    kind: "tool_definitions",
    label: name,
    text: json({ name, description: t.description, parameters: t.parameters }),
  };
}

function systemSections(message: Rec, leading: boolean, parts?: KobePromptParts): RawSection[] {
  const out: RawSection[] = [];
  const { text } = contentOf(message.content);
  const sections = isRecord(message.sections) ? message.sections : undefined;
  if (text !== "") {
    if (leading && sections === undefined) out.push(...splitForcedPrompt(text, parts));
    else out.push({ kind: "system_prompt", label: leading ? "Prompt" : "Prompt update", text });
  }
  for (const [name, value] of Object.entries(sections ?? {})) {
    const label = leading ? labelOfSection(name) : `${labelOfSection(name)} (updated)`;
    if (typeof value === "string") out.push({ kind: kindOfSection(name), label, text: value });
    else if (value === null) out.push({ kind: "other", label: `${label}: removed`, text: "" });
  }
  for (const tool of Array.isArray(message.toolsAdded) ? message.toolsAdded : []) {
    out.push(toolSection(tool));
  }
  const removed = Array.isArray(message.toolsRemoved) ? message.toolsRemoved : [];
  if (removed.length > 0) {
    const names = removed.map((t) => (isRecord(t) ? str(t.name) : "")).filter((n) => n !== "");
    out.push({ kind: "other", label: "Tools removed", text: names.join("\n") });
  }
  return out;
}

function userSection(content: unknown): RawSection {
  const { text, images } = contentOf(content);
  const counted = images > 0 ? { images } : {};
  if (text.startsWith(COMPACTION_SUMMARY_PREFIX)) {
    return { kind: "compaction_summary", label: "Compaction summary", text, ...counted };
  }
  if (text.startsWith(BRANCH_SUMMARY_PREFIX)) {
    return { kind: "other", label: "Branch summary", text, ...counted };
  }
  return { kind: "user_message", label: "User", text, ...counted };
}

function assistantSections(message: Rec): RawSection[] {
  const content = Array.isArray(message.content) ? message.content : [];
  return content.flatMap((block: unknown): RawSection[] => {
    if (!isRecord(block)) return [];
    if (block.type === "text") {
      return [{ kind: "assistant_message", label: "Assistant", text: str(block.text) }];
    }
    if (block.type === "thinking") {
      return [{ kind: "assistant_message", label: "Thinking", text: str(block.thinking) }];
    }
    if (block.type === "toolCall") {
      return [{ kind: "tool_call", label: str(block.name) || "tool", text: json(block.arguments) }];
    }
    return [];
  });
}

function messageSections(message: unknown, index: number, parts?: KobePromptParts): RawSection[] {
  if (!isRecord(message)) return [];
  switch (message.role) {
    case "system":
      return systemSections(message, index === 0, parts);
    case "user":
      return [userSection(message.content)];
    case "assistant":
      return assistantSections(message);
    case "toolResult": {
      const { text, images } = contentOf(message.content);
      const name = str(message.toolName) || "tool";
      const label = message.isError === true ? `${name} (error)` : name;
      return [{ kind: "tool_result", label, text, ...(images > 0 ? { images } : {}) }];
    }
    // Session messages Pi converts before the call (`convertToLlm`).
    case "compactionSummary":
      return [
        {
          kind: "compaction_summary",
          label: "Compaction summary",
          text: COMPACTION_SUMMARY_PREFIX + str(message.summary) + COMPACTION_SUMMARY_SUFFIX,
        },
      ];
    case "branchSummary":
      return [
        {
          kind: "other",
          label: "Branch summary",
          text: BRANCH_SUMMARY_PREFIX + str(message.summary) + BRANCH_SUMMARY_SUFFIX,
        },
      ];
    case "custom": {
      const { text, images } = contentOf(message.content);
      const label = str(message.customType) || "Custom message";
      return [{ kind: "other", label, text, ...(images > 0 ? { images } : {}) }];
    }
    default:
      return [{ kind: "other", label: str(message.role) || "message", text: json(message) }];
  }
}

/** The messages of a captured context: pi-ai `Context` fields first, as `normalizeContext` does. */
export function contextMessages(context: unknown): unknown[] {
  if (!isRecord(context)) return [];
  const messages = Array.isArray(context.messages) ? context.messages : [];
  const prompt = str(context.systemPrompt);
  const tools = Array.isArray(context.tools) ? context.tools : [];
  if (prompt === "" && tools.length === 0) return messages;
  return [{ role: "system", content: prompt, toolsAdded: tools }, ...messages];
}

export function sectionsOf(messages: readonly unknown[], parts?: KobePromptParts): RawSection[] {
  return messages.flatMap((m, i) => messageSections(m, i, parts));
}

export type { RawSection, KobePromptParts };
