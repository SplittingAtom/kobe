"use client";

import { useEffect, useState } from "react";
import type { ApiResult } from "../../lib/api/client";
import type { MemoryItem, MemoryItemsApi, Overrides } from "../../lib/memory/items-api";
import { visible } from "../../lib/security/visible";
import { Badge, Button, Notice } from "../ui/console";
import { CheckProblem, itemAnchor, useCheckedSave } from "./item-checks";
import { DraftFields, KIND_LABELS, draftError, parseTags, type Draft } from "./item-fields";

/** A change that was made, as the Undo bar shows it. */
export interface Done {
  readonly message: string;
  readonly undo?: (overrides: Overrides) => Promise<ApiResult<MemoryItem>>;
}

/** Names a row's buttons: the statement's start, as plain text. */
export const shortName = (statement: string) => {
  const text = visible(statement.replace(/\s+/g, " ").trim());
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
};

/** Ids of a row's controls, so focus can return to them after the lists change. */
export const editButtonId = (id: string) => `${itemAnchor(id)}-edit`;
export const pinButtonId = (id: string) => `${itemAnchor(id)}-pin`;

const sameTags = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((t, i) => t === b[i]);

/** Where focus goes once the lists show a change: an element id, or the row's group heading. */
export type FocusAfter = string | "group" | "archive";

/**
 * One memory: its statement (plain text, hidden characters escaped), kind, tags and pin, with
 * Edit, Pin and Archive (Restore when archived). Every change goes through the save checks; the
 * server's answer goes to `onChanged` with a way back for the Undo bar and where focus goes next.
 * A version conflict keeps the draft: Reload shows the saved text beside it and saves over it.
 */
export function ItemRow({
  item,
  api,
  known,
  onChanged,
  onRefreshed,
}: {
  readonly item: MemoryItem;
  readonly api: MemoryItemsApi;
  readonly known: ReadonlyMap<string, MemoryItem>;
  readonly onChanged: (item: MemoryItem, done: Done, focus: FocusAfter) => void;
  /** The item as saved now (Reload after a conflict); no Undo. */
  readonly onRefreshed: (item: MemoryItem) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  /** The version the draft started from; a newer `item.version` means someone saved meanwhile. */
  const [base, setBase] = useState(item.version);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const { busy, problem, save, clear } = useCheckedSave();
  const name = shortName(item.statement);
  const archived = item.status !== "active";
  const moved = draft !== null && item.version !== base;

  /** Cancel: back to Edit once the form is gone. */
  const [refocus, setRefocus] = useState(false);
  useEffect(() => {
    if (!refocus || draft !== null) return;
    document.getElementById(editButtonId(item.id))?.focus();
    setRefocus(false);
  }, [refocus, draft, item.id]);

  const close = () => {
    clear();
    setDraft(null);
    setRefocus(true);
  };

  const startEdit = () => {
    clear();
    setInvalid(null);
    setBase(item.version);
    setDraft({ statement: item.statement, kind: item.kind, tags: item.tags.join(", ") });
  };

  const reload = async () => {
    setReloadError(null);
    const res = await api.get(item.scope, item.id);
    if (!res.ok) return setReloadError(res.error.message);
    clear();
    onRefreshed(res.data);
  };

  const submitEdit = () => {
    if (draft === null) return;
    const bad = draftError(draft);
    setInvalid(bad);
    if (bad) return;
    const tags = parseTags(draft.tags);
    const statementChanged = draft.statement !== item.statement;
    const kindChanged = draft.kind !== item.kind;
    const tagsChanged = !sameTags(tags, item.tags);
    if (!statementChanged && !kindChanged && !tagsChanged) return close();
    const before = item;
    void save(
      (o) =>
        api.patch(
          before,
          {
            expectedVersion: before.version,
            ...(statementChanged ? { statement: draft.statement } : {}),
            ...(kindChanged ? { kind: draft.kind } : {}),
            ...(tagsChanged ? { tags } : {}),
          },
          o,
        ),
      (after) => {
        setDraft(null);
        onChanged(
          after,
          {
            message: "Memory saved.",
            // A statement-only edit is undone by copying the version before it (revert); anything
            // else by setting the fields back.
            undo:
              statementChanged && !kindChanged && !tagsChanged
                ? (o) => api.revert(after, before.version, after.version, o)
                : (o) =>
                    api.patch(
                      after,
                      {
                        expectedVersion: after.version,
                        ...(statementChanged ? { statement: before.statement } : {}),
                        ...(kindChanged ? { kind: before.kind } : {}),
                        ...(tagsChanged ? { tags: before.tags } : {}),
                      },
                      o,
                    ),
          },
          editButtonId(after.id),
        );
      },
    );
  };

  const togglePin = () =>
    void save(
      () => api.pin(item, !item.pinned),
      (after) =>
        onChanged(
          after,
          {
            message: after.pinned ? "Pinned." : "Unpinned.",
            undo: () => api.pin(after, !after.pinned),
          },
          pinButtonId(after.id),
        ),
    );

  const archive = () =>
    void save(
      () => api.archive(item),
      (after) =>
        onChanged(after, { message: "Archived.", undo: (o) => api.restore(after, o) }, "group"),
    );

  const restore = () =>
    void save(
      (o) => api.restore(item, o),
      (after) =>
        onChanged(after, { message: "Restored.", undo: () => api.archive(after) }, "archive"),
    );

  return (
    <li
      id={itemAnchor(item.id)}
      tabIndex={-1}
      aria-label={name}
      className="box-border rounded-md border border-console-border p-3 focus:outline-2 focus:outline-console-accent"
    >
      {draft === null ? (
        <>
          <p className="m-0 [overflow-wrap:anywhere] whitespace-pre-wrap">
            {visible(item.statement)}
          </p>
          <p className="m-0 mt-2 flex flex-wrap items-center gap-1 text-sm text-console-muted">
            <span>{KIND_LABELS[item.kind]}</span>
            {item.pinned && <Badge tone="accent">Pinned</Badge>}
            {archived && <Badge>Archived</Badge>}
            {item.tags.map((t) => (
              <Badge key={t}>{visible(t)}</Badge>
            ))}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {archived ? (
              <Button size="sm" disabled={busy} aria-label={`Restore: ${name}`} onClick={restore}>
                Restore
              </Button>
            ) : (
              <>
                <Button
                  id={editButtonId(item.id)}
                  size="sm"
                  disabled={busy}
                  aria-label={`Edit: ${name}`}
                  onClick={startEdit}
                >
                  Edit
                </Button>
                <Button
                  id={pinButtonId(item.id)}
                  size="sm"
                  disabled={busy}
                  aria-label={`Pin: ${name}`}
                  aria-pressed={item.pinned}
                  onClick={togglePin}
                >
                  Pin
                </Button>
                <Button size="sm" disabled={busy} aria-label={`Archive: ${name}`} onClick={archive}>
                  Archive
                </Button>
              </>
            )}
          </div>
        </>
      ) : (
        <form
          aria-label={`Editing: ${name}`}
          onSubmit={(e) => {
            e.preventDefault();
            submitEdit();
          }}
        >
          {moved && (
            <Notice tone="info" title={`Saved now (version ${item.version})`}>
              <p data-testid="saved-now" className="[overflow-wrap:anywhere] whitespace-pre-wrap">
                {visible(item.statement)}
              </p>
              <p>Your draft is kept below. Save replaces the saved text with it.</p>
            </Notice>
          )}
          <DraftFields
            draft={draft}
            onChange={setDraft}
            label="Memory text"
            preferenceOnly={item.scope === "portable"}
            autoFocus
          />
          {invalid && (
            <p role="alert" className="m-0 mt-2 text-sm text-status-failed">
              {invalid}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button type="submit" variant="primary" size="sm" disabled={busy}>
              Save
            </Button>
            <Button size="sm" disabled={busy} onClick={close}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {problem && (
        <CheckProblem problem={problem} known={known} busy={busy} onReload={() => void reload()} />
      )}
      {reloadError && (
        <Notice tone="error">
          <p>{reloadError}</p>
        </Notice>
      )}
    </li>
  );
}
