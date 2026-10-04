import { CONTEXT_OMITTED_MAX_ITEMS } from "@kobe/protocol";
import type { Omission } from "../resolver/resolve.js";

/** Longest `context.omitted` item name (the protocol bound). */
export const OMISSION_NAME_MAX = 256;

/**
 * The `context.omitted` items for a run's omissions: names clamped to the protocol bound (with an
 * ellipsis), empty names dropped, at most the protocol's item count. Undefined when nothing is
 * left, so the caller skips the event: a payload the schema rejects would roll back the start.
 */
export function omittedItems(omissions: readonly Omission[]): Omission[] | undefined {
  const items = omissions
    .filter((o) => o.name.trim() !== "")
    .map((o) =>
      o.name.length > OMISSION_NAME_MAX
        ? { ...o, name: `${o.name.slice(0, OMISSION_NAME_MAX - 1)}…` }
        : o,
    )
    .slice(0, CONTEXT_OMITTED_MAX_ITEMS);
  return items.length > 0 ? items : undefined;
}
