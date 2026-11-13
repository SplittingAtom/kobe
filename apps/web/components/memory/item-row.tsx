"use client";

import { useState } from "react";
import type { ApiResult } from "../../lib/api/client";
import type { MemoryItem, MemoryItemsApi, Overrides } from "../../lib/memory/items-api";
import { visible } from "../../lib/security/visible";
import { Badge, Button } from "../ui/console";
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

const sameTags = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((t, i) => t === b[i]);

/**
 * One memory: its statement (plain text, hidden characters escaped), kind, tags and pin, with
 * Edit, Pin and Archive (Restore when archived). Every change goes through the save checks and
 * hands the Undo bar a way back.
 */
export function ItemRow({
  item,
  api,
  known,
  onDone,
  onReload,
  onArchived,
}: {
  readonly item: MemoryItem;
  readonly api: MemoryItemsApi;
  readonly known: ReadonlyMap<string, MemoryItem>;
  readonly onDone: (done: Done) => void;
  readonly onReload: () => void;
  /** After the row left the list: focus moves to its group. */
  readonly onArchived: () => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const { busy, problem, save, clear } = useCheckedSave();
  const name = shortName(item.statement);
  const archived = item.status !== "active";

  const startEdit = () => {
    clear();
    setInvalid(null);
    setDraft({ statement: item.statement, kind: item.kind, tags: item.tags.join(", ") });
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
    if (!statementChanged && !kindChanged && !tagsChanged) return setDraft(null);
    void save(
      (o) =>
        api.patch(
          item,
          {
            expectedVersion: item.version,
            ...(statementChanged ? { statement: draft.statement } : {}),
            ...(kindChanged ? { kind: draft.kind } : {}),
            ...(tagsChanged ? { tags } : {}),
          },
          o,
        ),
      (after) => {
        setDraft(null);
        onDone({
          message: "Memory saved.",
          // A statement-only edit is undone by copying the version before it (revert); anything
          // else by setting the fields back.
          undo:
            statementChanged && !kindChanged && !tagsChanged
              ? (o) => api.revert(after, item.version, after.version, o)
              : (o) =>
                  api.patch(
                    after,
                    {
                      expectedVersion: after.version,
                      ...(statementChanged ? { statement: item.statement } : {}),
                      ...(kindChanged ? { kind: item.kind } : {}),
                      ...(tagsChanged ? { tags: item.tags } : {}),
                    },
                    o,
                  ),
        });
      },
    );
  };

  const togglePin = () =>
    void save(
      () => api.pin(item, !item.pinned),
      (after) =>
        onDone({
          message: after.pinned ? "Pinned." : "Unpinned.",
          undo: () => api.pin(after, !after.pinned),
        }),
    );

  const archive = () =>
    void save(
      () => api.archive(item),
      (after) => {
        onDone({ message: "Archived.", undo: (o) => api.restore(after, o) });
        onArchived();
      },
    );

  const restore = () =>
    void save(
      (o) => api.restore(item, o),
      (after) => onDone({ message: "Restored.", undo: () => api.archive(after) }),
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
                <Button size="sm" disabled={busy} aria-label={`Edit: ${name}`} onClick={startEdit}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  aria-label={`${item.pinned ? "Unpin" : "Pin"}: ${name}`}
                  aria-pressed={item.pinned}
                  onClick={togglePin}
                >
                  {item.pinned ? "Unpin" : "Pin"}
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
          <DraftFields
            draft={draft}
            onChange={setDraft}
            label="Memory text"
            preferenceOnly={item.scope === "portable"}
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
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                clear();
                setDraft(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {problem && <CheckProblem problem={problem} known={known} busy={busy} onReload={onReload} />}
    </li>
  );
}
