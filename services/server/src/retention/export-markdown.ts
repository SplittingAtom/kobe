/**
 * Markdown transcript of a thread for the user's export (spec D18). Entries are Pi 1.0 session
 * entries (D15) as stored, i.e. agent output: every field is checked, and anything unexpected is
 * left out instead of failing the export. Only the active branch (leaf to root) is rendered; the
 * JSONL next to it has every entry.
 */

const MAX_TOOL_TEXT = 4000;

type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function clip(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max)}\n… (${text.length - max} more characters)`
    : text;
}

/** A fence longer than any backtick run in `text`, so content can't close it. */
function fence(text: string, lang = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

/** One line of text safe in a heading or list item (no line breaks, no leading markup). */
export function inline(text: string): string {
  return text
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\p{Cc}]/gu, "")
    .trim();
}

/** Text of a Pi content field: a string, or the text parts of a part list (images noted). */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    const p = record(part);
    if (p?.type === "text" && typeof p.text === "string") parts.push(p.text);
    else if (p?.type === "image") parts.push("_(image)_");
  }
  return parts.join("\n\n");
}

function assistantMarkdown(message: Json): string {
  const out: string[] = [];
  const content = Array.isArray(message.content) ? message.content : [];
  for (const part of content) {
    const p = record(part);
    if (!p) continue;
    if (p.type === "text" && typeof p.text === "string") out.push(p.text);
    else if (p.type === "toolCall") {
      const name = inline(str(p.name) ?? "tool");
      let args: string;
      try {
        args = JSON.stringify(p.arguments ?? {}, null, 2);
      } catch {
        args = "{}";
      }
      out.push(
        `**Tool call:** \`${name.replace(/`/g, "")}\`\n\n${fence(clip(args, MAX_TOOL_TEXT), "json")}`,
      );
    }
  }
  const error = str(message.errorMessage);
  if (error) out.push(`_The model step ended with an error: ${inline(error)}_`);
  return out.join("\n\n");
}

/** The Markdown block of one entry, or null when it is not a conversation turn. */
export function entryMarkdown(payload: unknown): string | null {
  const entry = record(payload);
  if (entry?.type !== "message") return null;
  const message = record(entry.message);
  if (!message) return null;
  const when = str(entry.timestamp);
  const stamp = when ? ` · ${inline(when)}` : "";
  switch (message.role) {
    case "user":
      return `### You${stamp}\n\n${contentText(message.content)}`;
    case "assistant": {
      const body = assistantMarkdown(message);
      return body === "" ? null : `### Assistant${stamp}\n\n${body}`;
    }
    case "toolResult": {
      const name = inline(str(message.toolName) ?? "tool").replace(/`/g, "");
      const failed = message.isError === true ? " (error)" : "";
      const text = clip(contentText(message.content), MAX_TOOL_TEXT);
      return `**Tool result:** \`${name}\`${failed}\n\n${fence(text)}`;
    }
    default:
      return null;
  }
}

export interface ThreadHeading {
  readonly threadId: string;
  readonly title: string | null;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly inTrash: boolean;
}

export function threadHeader(thread: ThreadHeading): string {
  const title = inline(thread.title ?? "") || "Untitled conversation";
  const lines = [
    `# ${title.replace(/^#+\s*/, "")}`,
    "",
    `- Thread: \`${thread.threadId}\``,
    `- Started: ${thread.createdAt}`,
    `- Last activity: ${thread.lastActivityAt}`,
  ];
  if (thread.inTrash) lines.push("- In Trash");
  return `${lines.join("\n")}\n`;
}
