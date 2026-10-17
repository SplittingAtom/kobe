/**
 * Mentioning a workspace file from outside the `@` picker (KOBE-374): a row dragged from the Files
 * tree onto the composer, or its menu's "Mention in message". The result is exactly a pick
 * (KOBE-223): the protocol's marker in the text and the path in the draft's picked set, so the
 * send lists it in `mentions[]` and the server validates it as for any pick.
 */
import { MENTION_MAX_PER_MESSAGE, mentionMarker, mentionPathIssue } from "@kobe/protocol";

export const MENTION_FOLDER_REFUSED =
  "Folders can't be mentioned. Mention a file inside the folder instead.";
export const MENTION_NAME_REFUSED =
  "This file's name holds characters that can't go into a message. Rename it first.";
export const MENTION_LIMIT_REFUSED = `A message can mention at most ${MENTION_MAX_PER_MESSAGE} files.`;
export const MENTION_NO_COMPOSER =
  "Open a conversation of your own to mention a file in your message.";

/**
 * Why `path` can't be mentioned, or undefined when it can: the KOBE-223 rules (files only, never
 * `.kobe/`, no invisible, format or shell characters, length caps), and at most 20 per message
 * (`already` = the files the draft mentions now). Project mounts and uploads may be mentioned.
 */
export function mentionRefusal(
  path: string,
  type: "file" | "dir",
  already: readonly string[] = [],
): string | undefined {
  if (type === "dir") return MENTION_FOLDER_REFUSED;
  if (path === ".kobe" || path.startsWith(".kobe/") || mentionPathIssue(path) !== undefined) {
    return MENTION_NAME_REFUSED;
  }
  if (!already.includes(path) && already.length >= MENTION_MAX_PER_MESSAGE) {
    return MENTION_LIMIT_REFUSED;
  }
  return undefined;
}

/**
 * `text` with `path`'s marker inserted at `caret` (clamped), as the picker writes it: a space
 * before when the caret follows other text, one after; and where the caret ends up.
 */
export function insertMention(
  text: string,
  caret: number,
  path: string,
): { readonly text: string; readonly caret: number } {
  const at = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before === "" || /\s$/u.test(before) ? "" : " ";
  const marker = `${lead}${mentionMarker(path)} `;
  const rest = after.startsWith(" ") ? after.slice(1) : after;
  return { text: `${before}${marker}${rest}`, caret: before.length + marker.length };
}

/** Takes a mention into the composer; the answer is why it could not, or undefined. */
type Listener = (path: string) => string | undefined;

/**
 * The tab's way from the Files rail to the composer on screen. The composer that can take a
 * mention (a writable thread) listens; the latest listener wins. `request` answers why the
 * mention was not taken (no composer, or the composer's refusal), or undefined once it was.
 */
export class ComposerMentionChannel {
  #listeners: readonly Listener[] = [];

  listen(listener: Listener): () => void {
    // A fresh function per call, so the same listener registered twice is removed once.
    const own: Listener = (path) => listener(path);
    this.#listeners = [...this.#listeners, own];
    return () => {
      this.#listeners = this.#listeners.filter((l) => l !== own);
    };
  }

  request(path: string): string | undefined {
    const listener = this.#listeners.at(-1);
    return listener === undefined ? MENTION_NO_COMPOSER : listener(path);
  }
}
