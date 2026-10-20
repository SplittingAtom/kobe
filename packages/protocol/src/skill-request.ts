import { z } from "zod";
import { SKILL_NAME_PATTERN } from "./skill-package/layout.js";

/**
 * A skill the member picked for one message (KOBE-451, the composer's + menu): the message body
 * names it (`skill`), the server checks it is in the run's effective skill set, and writes one
 * fixed line before the member's text so the agent uses it. The chat recognises the line in
 * history and shows it as the skill chip. Only the server writes the line: member text that
 * imitates it is refused.
 */
export const skillRequestFieldSchema = z.string().regex(SKILL_NAME_PATTERN);

const LINE =
  /^Use the skill "([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)" for this message: read its SKILL\.md first and follow it\.(?:\n\n|$)/u;

/** The line the server writes for `name`, then a blank line and the member's text. */
export function withSkillRequest(name: string, text: string): string {
  return `Use the skill "${name}" for this message: read its SKILL.md first and follow it.\n\n${text}`;
}

/** The skill a run input or sent message asks for, and the member's own text after the line. */
export function splitSkillRequest(text: string): {
  readonly skill: string | null;
  readonly rest: string;
} {
  const match = LINE.exec(text);
  return match
    ? { skill: match[1] ?? null, rest: text.slice(match[0].length) }
    : { skill: null, rest: text };
}

/** Member text that would read as the server's skill line (refused, like app context). */
export function imitatesSkillRequest(text: string): boolean {
  return LINE.test(text.trimStart());
}
