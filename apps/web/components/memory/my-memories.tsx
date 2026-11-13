"use client";

import { SEMANTIC_MEMORY_NEAR_FULL_RATIO, SEMANTIC_MEMORY_PINS_MAX } from "@kobe/protocol";
import { useCallback, useMemo, useState } from "react";
import type { ApiResult } from "../../lib/api/client";
import {
  createMemoryItemsApi,
  describeItemError,
  type ItemScope,
  type MemoryItem,
  type MemoryItemList,
  type MemoryItemsApi,
} from "../../lib/memory/items-api";
import { ResourceView } from "../admin/parts";
import { useResource, type ResourceState } from "../admin/use-resource";
import { Button, EmptyState, Notice, PageHeader, Section } from "../ui/console";
import { AddMemory } from "./add-memory";
import { CheckProblem, useCheckedSave } from "./item-checks";
import { ItemRow, type Done } from "./item-row";

/** The two groups of the Me editor (Chris 2026-11-12, Q1: Workspace wording). */
const GROUPS: readonly {
  readonly scope: Extract<ItemScope, "user" | "portable">;
  readonly title: string;
  readonly description: string;
}[] = [
  {
    scope: "user",
    title: "This workspace",
    description: "Only you and your agents in this workspace read these.",
  },
  {
    scope: "portable",
    title: "All my workspaces",
    description: "Your preferences, used in every workspace you belong to.",
  },
];

const headingOf = (scope: ItemScope) => `memories-${scope}`;

/** Errors in Workspace wording. */
async function worded<T>(res: Promise<ApiResult<T>>): Promise<ApiResult<T>> {
  const r = await res;
  return r.ok ? r : { ...r, error: { ...r.error, message: describeItemError(r.error) } };
}

/**
 * The Memories tab (KOBE-384; SM5, SM6, SM21): your memories in **This workspace** and in **All
 * my workspaces**, with add, edit, archive, restore, pin and tags. Every save runs the KOBE-379
 * checks and shows their warnings inline (Save anyway), every change can be undone, and each
 * group says when it is 80% full or full.
 */
export function MyMemories({ teamId }: { readonly teamId: string }) {
  const api = useMemo(() => createMemoryItemsApi(teamId), [teamId]);
  const user = useResource(() => worded(api.list("user", "active")));
  const portable = useResource(() => worded(api.list("portable", "active")));
  const reloadUser = user.reload;
  const reloadPortable = portable.reload;
  const [archivedGeneration, setArchivedGeneration] = useState(0);
  const [done, setDone] = useState<Done | null>(null);
  const [undone, setUndone] = useState(false);

  const reload = useCallback(() => {
    reloadUser();
    reloadPortable();
    setArchivedGeneration((g) => g + 1);
  }, [reloadUser, reloadPortable]);

  const known = useMemo(() => {
    const map = new Map<string, MemoryItem>();
    for (const s of [user.state, portable.state])
      if (s.status === "ready") for (const i of s.data.items) map.set(i.id, i);
    return map;
  }, [user.state, portable.state]);

  const onDone = (d: Done) => {
    setUndone(false);
    setDone(d);
    reload();
  };

  return (
    <>
      <PageHeader
        title="My memories"
        description="Short statements Kobe knows about you, given to your agents at the start of each run. Nothing here is ever deleted: archive what you no longer want used."
      />
      <UndoBar
        done={done}
        undone={undone}
        known={known}
        onUndone={() => {
          setUndone(true);
          reload();
        }}
        onReload={reload}
      />
      <AddMemory api={api} known={known} onDone={onDone} onReload={reload} />
      {GROUPS.map((g) => (
        <ScopeGroup
          key={g.scope}
          {...g}
          api={api}
          state={g.scope === "user" ? user.state : portable.state}
          known={known}
          archivedGeneration={archivedGeneration}
          onDone={onDone}
          onReload={reload}
        />
      ))}
    </>
  );
}

/** The last change, announced, with Undo (itself checked: an undo can meet a warning too). */
function UndoBar({
  done,
  undone,
  known,
  onUndone,
  onReload,
}: {
  readonly done: Done | null;
  readonly undone: boolean;
  readonly known: ReadonlyMap<string, MemoryItem>;
  readonly onUndone: () => void;
  readonly onReload: () => void;
}) {
  const { busy, problem, save, clear } = useCheckedSave();
  const undo = done?.undo;
  return (
    <>
      <div role="status">
        {done && (
          <Notice
            tone="success"
            actions={
              !undone && undo ? (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    clear();
                    void save(undo, onUndone);
                  }}
                >
                  Undo
                </Button>
              ) : undefined
            }
          >
            <p>{undone ? "Undone." : done.message}</p>
          </Notice>
        )}
      </div>
      {problem && !undone && (
        <CheckProblem problem={problem} known={known} busy={busy} onReload={onReload} />
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
  title,
  description,
  api,
  state,
  known,
  archivedGeneration,
  onDone,
  onReload,
}: {
  readonly scope: ItemScope;
  readonly title: string;
  readonly description: string;
  readonly api: MemoryItemsApi;
  readonly state: ResourceState<MemoryItemList>;
  readonly known: ReadonlyMap<string, MemoryItem>;
  readonly archivedGeneration: number;
  readonly onDone: (done: Done) => void;
  readonly onReload: () => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const heading = headingOf(scope);
  const focusHeading = () => document.getElementById(heading)?.focus();
  return (
    <Section id={heading} title={title} description={description}>
      <ResourceView state={state} label="memories">
        {(data) => {
          const pinned = data.items.filter((i) => i.pinned).length;
          return (
            <>
              <UsageNotice usage={data.usage} />
              {data.items.length === 0 ? (
                <EmptyState title="No memories here yet.">
                  {scope === "portable"
                    ? "Add a preference and choose Use in all my workspaces."
                    : "Add one above, or ask your agent to remember something."}
                </EmptyState>
              ) : (
                <>
                  <p className="m-0 mb-2 text-sm text-console-muted">
                    {pinned} of {SEMANTIC_MEMORY_PINS_MAX} pinned. Pinned memories are always given
                    to your agents.
                  </p>
                  <ul aria-label={title} className="m-0 flex list-none flex-col gap-2 p-0">
                    {data.items.map((item) => (
                      <ItemRow
                        key={`${item.id}-${item.version}-${item.pinned}`}
                        item={item}
                        api={api}
                        known={known}
                        onDone={onDone}
                        onReload={onReload}
                        onArchived={focusHeading}
                      />
                    ))}
                  </ul>
                </>
              )}
            </>
          );
        }}
      </ResourceView>
      <div className="mt-3">
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={showArchived}
          onClick={() => setShowArchived((v) => !v)}
        >
          {showArchived ? `Hide archived (${title})` : `Show archived (${title})`}
        </Button>
      </div>
      {showArchived && (
        <Archived
          key={archivedGeneration}
          scope={scope}
          title={title}
          api={api}
          known={known}
          onDone={onDone}
          onReload={onReload}
        />
      )}
    </Section>
  );
}

function Archived({
  scope,
  title,
  api,
  known,
  onDone,
  onReload,
}: {
  readonly scope: ItemScope;
  readonly title: string;
  readonly api: MemoryItemsApi;
  readonly known: ReadonlyMap<string, MemoryItem>;
  readonly onDone: (done: Done) => void;
  readonly onReload: () => void;
}) {
  const { state } = useResource(() => worded(api.list(scope, "archived")));
  return (
    <ResourceView state={state} label="archived memories">
      {(data) =>
        data.items.length === 0 ? (
          <p className="text-sm text-console-muted">Nothing archived.</p>
        ) : (
          <ul
            aria-label={`Archived: ${title}`}
            className="m-0 mt-2 flex list-none flex-col gap-2 p-0"
          >
            {data.items.map((item) => (
              <ItemRow
                key={`${item.id}-${item.version}`}
                item={item}
                api={api}
                known={known}
                onDone={onDone}
                onReload={onReload}
                onArchived={() => undefined}
              />
            ))}
          </ul>
        )
      }
    </ResourceView>
  );
}
