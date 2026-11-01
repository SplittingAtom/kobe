/** Lineage answers (TL1) for the strip's tests (KOBE-535), validated by the protocol schema. */
import {
  threadLineageResponseSchema,
  type LineageAncestor,
  type LineageRelative,
  type ThreadLineageResponse,
} from "@kobe/protocol";

/** A thread id the schema accepts: `tid(7)`. */
export const tid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** The thread on screen in every fixture. */
export const SELF = tid(99);

export const relative = (n: number, title: string | null, inTrash = false): LineageRelative => ({
  thread_id: tid(n),
  title,
  deleted_at: inTrash ? "2026-10-30T10:00:00.000Z" : null,
  owner: "me",
});

export const ancestor = (
  n: number,
  title: string | null,
  siblings: readonly LineageRelative[] = [],
  options: { readonly inTrash?: boolean; readonly more?: boolean } = {},
): LineageAncestor => ({
  thread_id: tid(n),
  title,
  deleted_at: options.inTrash ? "2026-10-30T10:00:00.000Z" : null,
  siblings: [...siblings],
  siblings_more: options.more ?? false,
});

export function lineageOf(
  over: {
    readonly rootHidden?: boolean;
    readonly ancestors?: readonly LineageAncestor[];
    readonly title?: string | null;
    readonly forkedAt?: string | null;
    readonly selfSiblings?: readonly LineageRelative[];
    readonly forks?: readonly LineageRelative[];
    readonly forksMore?: boolean;
  } = {},
): ThreadLineageResponse {
  const ancestors = over.ancestors ?? [];
  return threadLineageResponseSchema.parse({
    thread_id: SELF,
    root_hidden: over.rootHidden ?? false,
    ancestors,
    self: {
      thread_id: SELF,
      title: over.title === undefined ? "Try the Q3 numbers" : over.title,
      forked_at_entry_id:
        over.forkedAt !== undefined
          ? over.forkedAt
          : ancestors.length > 0 || over.rootHidden
            ? "e-fork"
            : null,
      siblings: [...(over.selfSiblings ?? [])],
    },
    forks: [...(over.forks ?? [])],
    forks_more: over.forksMore ?? false,
  });
}
