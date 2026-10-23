"use client";

import { splitItemReferences } from "@kobe/protocol";
import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { moveItem, queuedMessages, queuingText } from "../../lib/chat/steering";
import type { ThreadController } from "../../lib/chat/thread-controller";
import { currentRunId, isBusy, type ThreadState } from "../../lib/chat/thread-state";
import type { PendingMessage } from "../../lib/chat/types";
import { IconAction } from "../shell/icon-action";
import { Button } from "../ui/button";

const CHIP =
  "bg-muted/60 flex max-w-[14rem] shrink-0 items-center gap-0.5 rounded-full border py-0.5 ps-0.5 pe-1 text-xs data-[dragging]:opacity-60";

interface Props {
  readonly state: ThreadState;
  readonly controller: ThreadController;
}

/** A queued message's own text, without the server's references line (KOBE-490 review MEDIUM-2). */
export function memberOwn(content: string): string {
  return splitItemReferences(content).rest;
}

/** Where a drag would drop: the chips whose centre lies left of the pointer (start-of-drag rects). */
function dropIndex(centres: readonly number[], from: number, x: number): number {
  return centres.filter((c, i) => i !== from && c < x).length;
}

function QueueEditor({
  message,
  position,
  state,
  controller,
  onDone,
}: Props & { readonly message: PendingMessage; readonly position: number; onDone(): void }) {
  const id = useId();
  // The server's references line (KOBE-490) is not the member's text: it stays with the message.
  const own = memberOwn(message.content);
  const [draft, setDraft] = useState(own);
  const save = async () => {
    const content = draft.trim();
    if (content === "" || content === own) return onDone();
    if (await controller.editQueued(message.runId, content)) onDone();
  };
  return (
    <div className="flex w-full flex-col gap-1">
      <label className="sr-only" htmlFor={id}>
        Edit queued message {position}
      </label>
      <textarea
        id={id}
        value={draft}
        autoFocus
        rows={2}
        className="bg-background w-full resize-none rounded-md border px-2 py-1 text-sm"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onDone();
          }
        }}
      />
      <div className="flex justify-end gap-1">
        <Button type="button" variant="ghost" size="xs" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="button"
          size="xs"
          onClick={() => void save()}
          disabled={isBusy(state, `edit:${message.runId}`)}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

/**
 * The queue row (CE10): queued messages as chips in run order. Click a chip to edit it, × deletes
 * it, and the grip reorders it by drag (pointer events) or by the arrow keys, Home and End.
 * Every change goes through the queue routes; the server's order wins on the next read.
 */
export function SteeringQueue({ state, controller }: Props) {
  const queued = queuedMessages(state);
  const queuing = queuingText(state);
  const [editing, setEditing] = useState<string | null>(null);
  // The dragged run and the run it would land on, by id: the queue may change mid-drag.
  const [drag, setDrag] = useState<{ id: string; target: string } | null>(null);
  const start = useRef<{ ids: readonly string[]; centres: readonly number[] }>({
    ids: [],
    centres: [],
  });
  const list = useRef<HTMLOListElement>(null);
  const hintId = useId();
  if (queued.length === 0 && queuing === undefined) return null;

  const ids = queued.map((m) => m.runId);
  const from = drag ? ids.indexOf(drag.id) : -1;
  const to = drag ? ids.indexOf(drag.target) : -1;
  const shown = from >= 0 && to >= 0 ? moveItem(queued, from, to) : queued;
  const reorder = (src: number, dst: number) => {
    const next = moveItem(ids, src, dst);
    if (next !== ids) void controller.reorderQueue(next);
  };

  const onPointerDown = (e: PointerEvent<HTMLElement>, id: string) => {
    if (e.button !== 0 || isBusy(state, "reorder")) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const chips = [...(list.current?.querySelectorAll("[data-queued]") ?? [])];
    start.current = {
      ids,
      centres: chips.map((c) => {
        const r = c.getBoundingClientRect();
        return r.left + r.width / 2;
      }),
    };
    setDrag({ id, target: id });
  };
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    if (!drag) return;
    const { ids: was, centres } = start.current;
    const target = was[dropIndex(centres, was.indexOf(drag.id), e.clientX)];
    if (target !== undefined && target !== drag.target) setDrag({ ...drag, target });
  };
  const onPointerUp = () => {
    // Resolved against the queue as it is now; a run that left meanwhile cancels the drop.
    if (from >= 0 && to >= 0) reorder(from, to);
    setDrag(null);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>, index: number) => {
    const to = {
      ArrowLeft: index - 1,
      ArrowUp: index - 1,
      ArrowRight: index + 1,
      ArrowDown: index + 1,
      Home: 0,
      End: ids.length - 1,
    }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    if (isBusy(state, "reorder")) return;
    reorder(index, to);
  };

  const editingMessage = queued.find((m) => m.runId === editing);
  return (
    <section aria-label="Queued messages" className="flex min-w-0 flex-col gap-1">
      <span id={hintId} className="sr-only">
        Drag, or use the arrow keys, Home and End, to change the order.
      </span>
      {state.queuePaused && currentRunId(state) !== undefined && (
        <p className="text-muted-foreground m-0 text-xs">
          Queue paused: these wait after the current run until you resume.
        </p>
      )}
      {editingMessage ? (
        <QueueEditor
          message={editingMessage}
          position={queued.indexOf(editingMessage) + 1}
          state={state}
          controller={controller}
          onDone={() => setEditing(null)}
        />
      ) : (
        <ol
          ref={list}
          className="m-0 flex min-w-0 list-none gap-1 overflow-x-auto overscroll-contain ps-0 pb-0.5"
        >
          {shown.map((m) => {
            const index = ids.indexOf(m.runId);
            const position = index + 1;
            return (
              <li
                key={m.runId}
                data-queued
                data-dragging={drag?.id === m.runId || undefined}
                aria-label={`Queued message ${position}`}
                className={CHIP}
              >
                <IconAction
                  command="move-queued"
                  label={`Move queued message ${position}`}
                  size="sm"
                  side="top"
                  aria-describedby={hintId}
                  className="cursor-grab touch-none active:cursor-grabbing"
                  disabled={isBusy(state, "reorder")}
                  onPointerDown={(e) => onPointerDown(e, m.runId)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={() => setDrag(null)}
                  onKeyDown={(e) => onKeyDown(e, index)}
                />
                <button
                  type="button"
                  title={memberOwn(m.content)}
                  aria-label={`Edit queued message ${position}: ${memberOwn(m.content)}`}
                  className="min-w-0 truncate rounded-full px-1 text-start hover:underline"
                  onClick={() => setEditing(m.runId)}
                >
                  {memberOwn(m.content)}
                </button>
                <IconAction
                  command="delete-queued"
                  label={`Delete queued message ${position}`}
                  size="sm"
                  side="top"
                  disabled={isBusy(state, `delete:${m.runId}`)}
                  onClick={() => void controller.cancelQueued(m.runId)}
                />
              </li>
            );
          })}
          {queuing !== undefined && (
            <li className={`${CHIP} text-muted-foreground px-2`} aria-label="Queuing">
              <span className="min-w-0 truncate">{queuing}</span>
              <span aria-hidden>…</span>
            </li>
          )}
        </ol>
      )}
    </section>
  );
}
