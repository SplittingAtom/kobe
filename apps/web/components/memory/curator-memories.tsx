"use client";

import { SEMANTIC_MEMORY_KINDS, SEMANTIC_MEMORY_SCOPE_LABELS } from "@kobe/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiError } from "../../lib/api/client";
import {
  createMemoryItemsApi,
  describeItemError,
  type ItemKind,
  type ItemStatus,
  type MemoryItem,
  type MemoryItemList,
} from "../../lib/memory/items-api";
import { ErrorNotice } from "../admin/error-notice";
import { Button, EmptyState, Field, Section, Select, TextInput } from "../ui/console";
import { CuratorAdd } from "./curator-add";
import { itemAnchor } from "./item-checks";
import { KIND_LABELS } from "./item-fields";
import { ItemRow, type Done, type FocusAfter } from "./item-row";
import { UndoBar, UsageNotice } from "./my-memories";
import { PolicyBudget } from "./policy-budget";

export type SharedScope = "team" | "site";

/** One scope the console lists, and whether the caller curates it there. */
export interface ListedScope {
  readonly scope: SharedScope;
  readonly curate: boolean;
}

/** Status filter: TODO KOBE-386 adds "stale" once its sweep defines it (ledger KOBE-385). */
const STATUS_LABELS: Readonly<Record<ItemStatus, string>> = {
  active: "Active",
  archived: "Archived",
  superseded: "Superseded",
};
type PolicyFilter = "all" | "policy" | "ordinary";

interface Filters {
  readonly scope: SharedScope;
  readonly status: ItemStatus;
  readonly kind: ItemKind | "";
  readonly tag: string;
  readonly policy: PolicyFilter;
}

type ListState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: ApiError }
  | {
      readonly status: "ready";
      readonly items: readonly MemoryItem[];
      readonly nextCursor: string | null;
      readonly usage: MemoryItemList["usage"];
    };

const LIST_HEADING = "curated-memories";
const worded = (error: ApiError): ApiError => ({ ...error, message: describeItemError(error) });

/**
 * The curators' Memories tab (KOBE-385; SM8, SM21) on the Workspace and Site console Memory
 * pages: one scope at a time with filters (scope, kind, tag, status; Policy on the Site), and
 * edit, archive, restore, pin and tags on every row through the KOBE-379 save checks with Undo
 * (KOBE-384's rows). A scope the caller doesn't curate is read-only. `canSetPolicy` (Site admins)
 * adds the Policy toggle and the Policy budget meter's actions.
 */
export function CuratorMemories({
  teamId,
  scopes,
  canSetPolicy = false,
}: {
  readonly teamId: string | undefined;
  readonly scopes: readonly ListedScope[];
  readonly canSetPolicy?: boolean;
}) {
  const api = useMemo(() => createMemoryItemsApi(teamId), [teamId]);
  const first = scopes[0]?.scope ?? "team";
  const [filters, setFilters] = useState<Filters>({
    scope: first,
    status: "active",
    kind: "",
    tag: "",
    policy: "all",
  });
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [pageError, setPageError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<{ readonly n: number; readonly done: Done } | null>(null);
  const [focus, setFocus] = useState<FocusAfter | null>(null);
  const curate = scopes.find((s) => s.scope === filters.scope)?.curate === true;
  const site = filters.scope === "site";

  const query = useCallback(
    (cursor: string | null) =>
      api.list({
        scope: filters.scope,
        status: filters.status,
        kind: filters.kind === "" ? undefined : filters.kind,
        policy: site && filters.policy !== "all" ? filters.policy === "policy" : undefined,
        cursor,
      }),
    [api, filters.scope, filters.status, filters.kind, filters.policy, site],
  );

  const load = useCallback(async () => {
    setState({ status: "loading" });
    const res = await query(null);
    setState(
      res.ok ? { status: "ready", ...res.data } : { status: "error", error: worded(res.error) },
    );
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (focus === null) return;
    const el = focus === "group" || focus === "archive" ? null : document.getElementById(focus);
    (el ?? document.getElementById(LIST_HEADING))?.focus();
    setFocus(null);
  }, [focus, state]);

  const more = async () => {
    if (state.status !== "ready" || !state.nextCursor) return;
    setPageError(null);
    const res = await query(state.nextCursor);
    if (!res.ok) return setPageError(worded(res.error));
    setState({
      ...state,
      items: [...state.items, ...res.data.items],
      nextCursor: res.data.nextCursor,
    });
  };

  /**
   * The answer replaces its row; a row that no longer matches the filters leaves the list. The
   * active count follows the item's move in or out of `active` (a new item comes from nowhere).
   */
  const place = (item: MemoryItem) =>
    setState((prev) => {
      if (prev.status !== "ready") return prev;
      const before = prev.items.find((i) => i.id === item.id);
      const fits = item.scope === filters.scope && item.status === filters.status;
      const items = !fits
        ? prev.items.filter((i) => i.id !== item.id)
        : before
          ? prev.items.map((i) => (i.id === item.id ? item : i))
          : [item, ...prev.items];
      const was = before ? before.status === "active" : false;
      const is = item.status === "active";
      const count = prev.usage.count + (is === was ? 0 : is ? 1 : -1);
      return { ...prev, items, usage: { ...prev.usage, count } };
    });

  /** Policy counts move with Policy changes the list can't see: ask again (Site only). */
  const refreshUsage = async () => {
    const res = await query(null);
    if (res.ok)
      setState((prev) => (prev.status === "ready" ? { ...prev, usage: res.data.usage } : prev));
  };

  const changed = (item: MemoryItem, d: Done, target: FocusAfter) => {
    place(item);
    if (site) void refreshUsage();
    setDone((prev) => ({ n: (prev?.n ?? 0) + 1, done: d }));
    setFocus(target);
  };

  const known = useMemo(() => {
    const map = new Map<string, MemoryItem>();
    if (state.status === "ready") for (const i of state.items) map.set(i.id, i);
    return map;
  }, [state]);

  const tag = filters.tag.trim().toLowerCase();
  const shown =
    state.status === "ready"
      ? state.items.filter((i) => tag === "" || i.tags.some((t) => t.includes(tag)))
      : [];
  const title = SEMANTIC_MEMORY_SCOPE_LABELS[filters.scope];
  const set = (change: Partial<Filters>) => setFilters((f) => ({ ...f, ...change }));

  return (
    <>
      <div role="status">
        {done && (
          <UndoBar
            key={done.n}
            done={done.done}
            known={known}
            onUndone={(item) => {
              place(item);
              setFocus(item.status === "active" ? itemAnchor(item.id) : "group");
            }}
          />
        )}
      </div>
      {curate && (
        <CuratorAdd
          api={api}
          scope={filters.scope}
          canSetPolicy={canSetPolicy}
          known={known}
          onSaved={(item, d) => {
            setDone((prev) => ({ n: (prev?.n ?? 0) + 1, done: d }));
            place(item);
          }}
          onReload={() => void load()}
        />
      )}
      <form
        aria-label="Filter memories"
        className="my-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => e.preventDefault()}
      >
        {scopes.length > 1 && (
          <Field label="Scope" className="w-fit">
            <Select
              value={filters.scope}
              onChange={(e) => set({ scope: e.target.value as SharedScope, policy: "all" })}
            >
              {scopes.map((s) => (
                <option key={s.scope} value={s.scope}>
                  {SEMANTIC_MEMORY_SCOPE_LABELS[s.scope]}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Kind" className="w-fit">
          <Select
            value={filters.kind}
            onChange={(e) => set({ kind: e.target.value as ItemKind | "" })}
          >
            <option value="">All kinds</option>
            {SEMANTIC_MEMORY_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Status" className="w-fit">
          <Select
            value={filters.status}
            onChange={(e) => set({ status: e.target.value as ItemStatus })}
          >
            {(Object.keys(STATUS_LABELS) as ItemStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        </Field>
        {site && (
          <Field label="Policy" className="w-fit">
            <Select
              value={filters.policy}
              onChange={(e) => set({ policy: e.target.value as PolicyFilter })}
            >
              <option value="all">Policy and other memories</option>
              <option value="policy">Policy only</option>
              <option value="ordinary">Not Policy</option>
            </Select>
          </Field>
        )}
        <Field label="Tag" hint="Matches the memories loaded so far.">
          <TextInput value={filters.tag} onChange={(e) => set({ tag: e.target.value })} />
        </Field>
      </form>
      <Section
        id={LIST_HEADING}
        title={title}
        description={
          curate ? undefined : "You can read these memories. Only their curators change them."
        }
      >
        {state.status === "loading" && <p role="status">Loading memories…</p>}
        {state.status === "error" && <ErrorNotice error={state.error} />}
        {state.status === "ready" && (
          <>
            {curate && <UsageNotice usage={state.usage} />}
            {site && <PolicyBudget usage={state.usage} />}
            <p className="m-0 mb-2 text-sm text-console-muted" aria-live="polite">
              {shown.length === 1 ? "1 memory shown" : `${shown.length} memories shown`}
              {state.nextCursor ? " (more to load)" : ""}.
            </p>
            {shown.length === 0 ? (
              <EmptyState title="No memories match.">
                {curate
                  ? "Add one above, or import a file under Import and export."
                  : "Nothing to show here yet."}
              </EmptyState>
            ) : (
              <ul aria-label={title} className="m-0 flex list-none flex-col gap-2 p-0">
                {shown.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    api={api}
                    known={known}
                    onChanged={changed}
                    onRefreshed={place}
                    readOnly={!curate}
                    canSetPolicy={canSetPolicy}
                  />
                ))}
              </ul>
            )}
            {state.nextCursor && (
              <Button className="mt-2" size="sm" onClick={() => void more()}>
                Show more ({title})
              </Button>
            )}
            {pageError && <ErrorNotice error={pageError} />}
          </>
        )}
      </Section>
    </>
  );
}
