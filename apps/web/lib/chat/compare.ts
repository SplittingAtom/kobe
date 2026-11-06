/**
 * Compare versions (CT10, KOBE-547): the pure half. A message's versions are its siblings in the
 * chat's projection (assistant-ui's "Version k of N"); each column shows one version's answer, and
 * for versions of a prompt the prompt too when the two prompts differ (an edit; a regenerate sends
 * the same text again). View-only: Show this version moves the head (CT3), never the leaf.
 */
import { messageMeta, type Projection, type ProjectedItem } from "./tree";

export const COMPARING = "Comparing versions";
export const COMPARE_TITLE = "Compare versions";
export const NO_COMPARE = "This message has no other versions to compare.";

export interface CompareVersion {
  /** The version's own message (a sibling of the others). */
  readonly id: string;
  /** Its place among all the message's siblings, 1-based: the picker's "Version k of N". */
  readonly k: number;
  readonly role: "user" | "assistant";
  /** The prompt shown above its answer: a version of a prompt. */
  readonly promptId?: string | undefined;
  /** The answer shown: the version itself, or a prompt's first answer (the newest one, if retried). */
  readonly answerId?: string | undefined;
  /** Where Show this version moves the head: the answer's last entry, else the version's. */
  readonly headEntry?: string | undefined;
  /** The entry to scroll to once it shows: the version's first entry. */
  readonly revealEntry?: string | undefined;
}

function committed(item: ProjectedItem): boolean {
  const meta = messageMeta(item.message);
  if (meta?.kind === "user") return !meta.pending && meta.entryId !== undefined;
  if (meta?.kind === "assistant") return !meta.live && meta.appCard !== true;
  return false;
}

function firstEntryOf(item: ProjectedItem): string | undefined {
  const meta = messageMeta(item.message);
  if (meta?.kind === "user") return meta.entryId;
  return meta?.kind === "assistant" ? meta.entryIds[0] : undefined;
}

/**
 * The versions of a message, in the picker's order (oldest first); empty when it has fewer than
 * two committed versions (a live answer or a pending prompt is not compared).
 */
export function versionsOf(
  projection: Pick<Projection, "items" | "lastEntryOfNode">,
  messageId: string,
): readonly CompareVersion[] {
  const items = projection.items;
  const self = items.find((i) => i.message.id === messageId);
  if (self === undefined) return [];
  const role = self.message.role;
  if (role !== "user" && role !== "assistant") return [];
  // The picker counts every sibling (a live or other-role one too): k is that position.
  const all = items.filter((i) => i.parentId === self.parentId);
  const siblings = all.filter((i) => i.message.role === role && committed(i));
  if (siblings.length < 2) return [];
  return siblings.map((item) => {
    const id = item.message.id;
    const answer =
      role === "assistant"
        ? item
        : items.findLast(
            (i) => i.parentId === id && i.message.role === "assistant" && committed(i),
          );
    const answerId = answer?.message.id;
    const headEntry = projection.lastEntryOfNode.get(answerId ?? id);
    const revealEntry = firstEntryOf(item);
    return {
      id,
      k: all.indexOf(item) + 1,
      role,
      ...(role === "user" ? { promptId: id } : {}),
      ...(answerId === undefined ? {} : { answerId }),
      ...(headEntry === undefined ? {} : { headEntry }),
      ...(revealEntry === undefined ? {} : { revealEntry }),
    };
  });
}

/** Which version each column shows, by message id. */
export type ComparePair = readonly [string, string];

/**
 * The pair the dialog opens with: a picked version (the tree's Compare with…, the palette's
 * focused message) on the left beside the newest other one; else the two newest, older left.
 */
export function initialPair(
  versions: readonly CompareVersion[],
  picked?: string,
): ComparePair | undefined {
  const newestOther = versions.findLast((v) => v.id !== picked);
  if (picked !== undefined && newestOther !== undefined && versions.some((v) => v.id === picked)) {
    return [picked, newestOther.id];
  }
  const [a, b] = versions.slice(-2);
  return a === undefined || b === undefined ? undefined : [a.id, b.id];
}

/** A column's dropdown picked `id`; the other column keeps its version. */
export function pickVersion(pair: ComparePair, side: 0 | 1, id: string): ComparePair {
  if (pair[1 - side] === id) return pair;
  return side === 0 ? [id, pair[1]] : [pair[0], id];
}

/** A column's dropdown: every version except the one in the other column. */
export function choicesFor(
  versions: readonly CompareVersion[],
  other: string,
): readonly CompareVersion[] {
  return versions.filter((v) => v.id !== other);
}

/** Whether a message can be compared (the picker's icon, the tree's menu, the palette). */
export function comparable(
  projection: Pick<Projection, "items" | "lastEntryOfNode">,
  messageId: string,
): boolean {
  return versionsOf(projection, messageId).length >= 2;
}

/** A heading, option or region name: "Version k", then its label (CT9) as the picker shows it. */
export function versionTitle(version: Pick<CompareVersion, "k">, label?: string): string {
  return label === undefined ? `Version ${version.k}` : `Version ${version.k} · ${label}`;
}

/** What a prompt sent: its words, skill, app items and files (the projection's meta). */
function promptSent(projection: Pick<Projection, "items">, id: string | undefined): string {
  if (id === undefined) return "";
  const item = projection.items.find((i) => i.message.id === id);
  const meta = item ? messageMeta(item.message) : undefined;
  if (meta?.kind !== "user") return "";
  return JSON.stringify([
    meta.text,
    meta.skill ?? null,
    meta.references ?? [],
    (meta.attachments ?? []).map((f) => [f.name, f.mimeType, f.path ?? null]),
  ]);
}

/**
 * Whether the columns show their prompts: versions of a prompt that sent something different (an
 * edit: other words, skill, items or files); a regenerate sends the same again.
 */
export function promptsDiffer(
  projection: Pick<Projection, "items">,
  a: CompareVersion | undefined,
  b: CompareVersion | undefined,
): boolean {
  if (a?.promptId === undefined || b?.promptId === undefined) return false;
  return promptSent(projection, a.promptId) !== promptSent(projection, b.promptId);
}
