"use client";

import {
  SEMANTIC_MEMORY_NEAR_FULL_RATIO,
  SEMANTIC_MEMORY_PINS_MAX,
  SEMANTIC_MEMORY_SCOPE_LABELS,
} from "@kobe/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiError } from "../../lib/api/client";
import { appendPage, listedItems, placeItem, type ScopeLists } from "../../lib/memory/item-lists";
import {
  createMemoryItemsApi,
  describeItemError,
  type MemoryItem,
  type MemoryItemList,
  type MemoryItemsApi,
} from "../../lib/memory/items-api";
import { ErrorNotice } from "../admin/error-notice";
import { Button, EmptyState, Notice, Section } from "../ui/console";
import { AddMemory } from "./add-memory";
import { CheckProblem, itemAnchor, useCheckedSave } from "./item-checks";
import { ItemRow, type Done, type FocusAfter } from "./item-row";

type MyScope = "user" | "portable";

/** The Me editor's groups; titles from the one scope label map (KOBE-384 review H1). */
const GROUPS: readonly { readonly scope: MyScope; readonly description: string }[] = [
  { scope: "user", description: "Only you and your agents in this workspace read these." },
  {
    scope: "portable",
    description: "Your preferences, used in every workspace you belong to.",
  },
];

const headingOf = (scope: MyScope) => `memories-${scope}`;
const archiveHeadingOf = (scope: MyScope) => `memories-${scope}-archived`;

const worded = (error: ApiError): ApiError => ({ ...error, message: describeItemError(error) });

type ListsState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: ApiError }
  | { readonly status: "ready"; readonly lists: ScopeLists };

/**
 * One group's lists: pinned first (their own request, so the "n of 10" count is exact), then the
 * rest page by page, and the archive once opened. Server answers are placed in the lists.
 */
function useScopeLists(api: MemoryItemsApi, scope: MyScope) {
  const [state, setState] = useState<ListsState>({ status: "loading" });
  const [pageError, setPageError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    const [pinned, others] = await Promise.all([
      api.list({ scope, status: "active", pinned: true }),
      api.list({ scope, status: "active", pinned: false }),
    ]);
    if (!pinned.ok) return setState({ status: "error", error: worded(pinned.error) });
    if (!others.ok) return setState({ status: "error", error: worded(others.error) });
    setState((prev) => ({
      status: "ready",
      lists: {
        pinned: pinned.data.items,
        others: { items: others.data.items, nextCursor: others.data.nextCursor },
        archived: prev.status === "ready" ? prev.lists.archived : null,
        usage: others.data.usage,
      },
    }));
  }, [api, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = (fn: (lists: ScopeLists) => ScopeLists) =>
    setState((prev) => (prev.status === "ready" ? { ...prev, lists: fn(prev.lists) } : prev));

  const fetchPage = async (archived: boolean, cursor: string | null) => {
    setPageError(null);
    const res = await api.list({
      scope,
      status: archived ? "archived" : "active",
      cursor,
      ...(archived ? {} : { pinned: false }),
    });
    if (!res.ok) {
      setPageError(worded(res.error));
      return null;
    }
    return res.data;
  };

  const more = async (archived: boolean) => {
    if (state.status !== "ready") return;
    const page = archived ? state.lists.archived : state.lists.others;
    if (!page?.nextCursor) return;
    const next = await fetchPage(archived, page.nextCursor);
    if (next)
      update((l) =>
        archived
          ? { ...l, archived: appendPage(l.archived ?? { items: [], nextCursor: null }, next) }
          : { ...l, others: appendPage(l.others, next) },
      );
  };

  const openArchive = async () => {
    const first = await fetchPage(true, null);
    if (first)
      update((l) => ({ ...l, archived: { items: first.items, nextCursor: first.nextCursor } }));
  };

  const place = (item: MemoryItem) => update((l) => placeItem(l, item));

  return { state, pageError, load, more, openArchive, place };
}

type Lists = ReturnType<typeof useScopeLists>;

/**
 * The Memories tab (KOBE-384; SM5, SM6, SM21): your memories **Only in this workspace** and in
 * **All my workspaces**, with add, edit, archive, restore, pin and tags. Every save runs the
 * KOBE-379 checks and shows their warnings inline (Save anyway), every change can be undone,
 * each group says when it is 80% full or full, and focus stays on what you were working on.
 */
export function MyMemories({ teamId }: { readonly teamId: string }) {
  const api = useMemo(() => createMemoryItemsApi(teamId), [teamId]);
  const user = useScopeLists(api, "user");
  const portable = useScopeLists(api, "portable");
  const listsOf = (scope: string): Lists => (scope === "portable" ? portable : user);
  const [done, setDone] = useState<{ readonly n: number; readonly done: Done } | null>(null);
  const [focus, setFocus] = useState<{ scope: MyScope; target: FocusAfter } | null>(null);

  useEffect(() => {
    if (focus === null) return;
    const byId = (id: string) => document.getElementById(id);
    const group = byId(headingOf(focus.scope));
    const el =
      focus.target === "group"
        ? group
        : focus.target === "archive"
          ? (byId(archiveHeadingOf(focus.scope)) ?? group)
          : (byId(focus.target) ?? group);
    el?.focus();
    setFocus(null);
  }, [focus, user.state, portable.state]);

  const known = useMemo(() => {
    const map = new Map<string, MemoryItem>();
    for (const s of [user.state, portable.state])
      if (s.status === "ready") for (const i of listedItems(s.lists)) map.set(i.id, i);
    return map;
  }, [user.state, portable.state]);

  const reloadAll = () => {
    void user.load();
    void portable.load();
  };

  const changed = (item: MemoryItem, d: Done, target: FocusAfter) => {
    listsOf(item.scope).place(item);
    setDone((prev) => ({ n: (prev?.n ?? 0) + 1, done: d }));
    setFocus({ scope: item.scope === "portable" ? "portable" : "user", target });
  };

  return (
    <>
      <p className="m-0 mb-4 text-console-muted">
        Short statements Kobe knows about you, given to your agents at the start of each run.
        Nothing here is ever deleted: archive what you no longer want used.
      </p>
      {/* On the page from the start, so the change's message is announced when it appears. */}
      <div role="status">
        {done && (
          <UndoBar
            key={done.n}
            done={done.done}
            known={known}
            onUndone={(item) => {
              listsOf(item.scope).place(item);
              setFocus({
                scope: item.scope === "portable" ? "portable" : "user",
                target: item.status === "active" ? itemAnchor(item.id) : "group",
              });
            }}
          />
        )}
      </div>
      <AddMemory
        api={api}
        known={known}
        onSaved={(item, d) => {
          listsOf(item.scope).place(item);
          setDone((prev) => ({ n: (prev?.n ?? 0) + 1, done: d }));
        }}
        onReload={reloadAll}
      />
      {GROUPS.map((g) => (
        <ScopeGroup
          key={g.scope}
          {...g}
          api={api}
          lists={listsOf(g.scope)}
          known={known}
          onChanged={changed}
        />
      ))}
    </>
  );
}

/**
 * The last change, announced, with Undo (itself checked: an undo can meet a warning too). Keyed by
 * the change, so a new change clears an old Undo's warning. An Undo the item outran (version
 * conflict) is withdrawn.
 */
function UndoBar({
  done,
  known,
  onUndone,
}: {
  readonly done: Done;
  readonly known: ReadonlyMap<string, MemoryItem>;
  readonly onUndone: (item: MemoryItem) => void;
}) {
  const { busy, problem, save, clear } = useCheckedSave();
  const [undone, setUndone] = useState(false);
  const stale = problem?.error.code === "memory_version_conflict";
  const undo = done.undo;
  return (
    <>
      <Notice
        tone="success"
        actions={
          !undone && !stale && undo ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                clear();
                void save(undo, (item) => {
                  setUndone(true);
                  onUndone(item);
                });
              }}
            >
              Undo
            </Button>
          ) : undefined
        }
      >
        <p>{undone ? "Undone." : done.message}</p>
      </Notice>
      {stale ? (
        <Notice tone="warn">
          <p>This change can no longer be undone: the memory changed since.</p>
        </Notice>
      ) : (
        problem &&
        !undone && (
          <CheckProblem problem={problem} known={known} busy={busy} onReload={() => undefined} />
        )
      )}
    </>
  );
}

/** How full a group is: a notice from 80% (SM21, KOBE-645's threshold), another when full. */
function UsageNotice({ usage }: { readonly usage: MemoryItemList["usage"] }) {
  if (usage.count >= usage.max)
    return (
      <Notice tone="warn" title="Full">
        <p>
          {usage.count} of {usage.max} memories. Archive one before adding another.
        </p>
      </Notice>
    );
  if (usage.count >= Math.ceil(usage.max * SEMANTIC_MEMORY_NEAR_FULL_RATIO))
    return (
      <Notice tone="info" title="Nearly full">
        <p>
          {usage.count} of {usage.max} memories used. Archive what you no longer need.
        </p>
      </Notice>
    );
  return null;
}

function ScopeGroup({
  scope,
  description,
  api,
  lists,
  known,
  onChanged,
}: {
  readonly scope: MyScope;
  readonly description: string;
  readonly api: MemoryItemsApi;
  readonly lists: Lists;
  readonly known: ReadonlyMap<string, MemoryItem>;
  readonly onChanged: (item: MemoryItem, done: Done, focus: FocusAfter) => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const title = SEMANTIC_MEMORY_SCOPE_LABELS[scope];
  const archiveId = `${archiveHeadingOf(scope)}-region`;
  const { state } = lists;
  const row = (item: MemoryItem) => (
    <ItemRow
      key={item.id}
      item={item}
      api={api}
      known={known}
      onChanged={onChanged}
      onRefreshed={lists.place}
    />
  );
  return (
    <Section id={headingOf(scope)} title={title} description={description}>
      {state.status === "loading" && <p role="status">Loading memories…</p>}
      {state.status === "error" && <ErrorNotice error={state.error} />}
      {state.status === "ready" && (
        <>
          <UsageNotice usage={state.lists.usage} />
          {state.lists.pinned.length + state.lists.others.items.length === 0 ? (
            <EmptyState title="No memories here yet.">
              {scope === "portable"
                ? "Add a preference and choose Use in all my workspaces."
                : "Add one above, or ask your agent to remember something."}
            </EmptyState>
          ) : (
            <>
              <p className="m-0 mb-2 text-sm text-console-muted">
                {state.lists.pinned.length} of {SEMANTIC_MEMORY_PINS_MAX} pinned. Pinned memories
                are listed first and always given to your agents.
              </p>
              <ul aria-label={title} className="m-0 flex list-none flex-col gap-2 p-0">
                {state.lists.pinned.map(row)}
                {state.lists.others.items.map(row)}
              </ul>
              {state.lists.others.nextCursor && (
                <Button className="mt-2" size="sm" onClick={() => void lists.more(false)}>
                  Show more ({title})
                </Button>
              )}
            </>
          )}
          {lists.pageError && <ErrorNotice error={lists.pageError} />}
          <div className="mt-3">
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={showArchived}
              aria-controls={archiveId}
              onClick={() => {
                if (!showArchived && state.lists.archived === null) void lists.openArchive();
                setShowArchived((v) => !v);
              }}
            >
              {showArchived ? `Hide archived (${title})` : `Show archived (${title})`}
            </Button>
          </div>
          <div id={archiveId} hidden={!showArchived}>
            {showArchived && (
              <>
                <h3
                  id={archiveHeadingOf(scope)}
                  tabIndex={-1}
                  className="m-0 mt-3 text-base font-semibold focus:outline-none"
                >
                  Archived
                </h3>
                {state.lists.archived === null ? (
                  <p role="status">Loading archived memories…</p>
                ) : state.lists.archived.items.length === 0 ? (
                  <p className="text-sm text-console-muted">Nothing archived.</p>
                ) : (
                  <>
                    <ul
                      aria-label={`Archived: ${title}`}
                      className="m-0 mt-2 flex list-none flex-col gap-2 p-0"
                    >
                      {state.lists.archived.items.map(row)}
                    </ul>
                    {state.lists.archived.nextCursor && (
                      <Button className="mt-2" size="sm" onClick={() => void lists.more(true)}>
                        Show more archived ({title})
                      </Button>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </>
      )}
    </Section>
  );
}
