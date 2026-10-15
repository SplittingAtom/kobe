"use client";

import { createContext, useContext, useState, type FormEvent } from "react";
import { Dialog } from "radix-ui";
import { THREAD_TITLE_MAX } from "@kobe/protocol";
import { forkPointOf, type ForkPoint } from "../../lib/chat/fork";
import { chatPortalContainer } from "../../lib/chat/portal-container";
import type { KobeMessageMeta } from "../../lib/chat/tree";
import { IconAction } from "../shell/icon-action";
import { Button } from "../ui/button";
import { useChatSession, useKobeExtras } from "./kobe-runtime";

/** Opens a thread in the chat (the `?thread=` URL); provided by `ThreadView`. */
export const OpenThreadContext = createContext<((threadId: string) => void) | undefined>(undefined);

/**
 * "Fork to a new thread" on a message (CE16, KOBE-216): asks for a title, then the server copies
 * the conversation into a new thread of yours in the same project and opens it: up to an answer,
 * or up to just before a prompt, which then waits in the new thread's composer (`forkPointOf`).
 * Shown for committed messages only (a pending prompt or a live answer has no entry yet).
 */
export function ForkAction({ meta }: { readonly meta: KobeMessageMeta | undefined }) {
  const [open, setOpen] = useState(false);
  const extras = useKobeExtras();
  const point = forkPointOf(meta);
  if (point === undefined || !extras?.controller || extras.state.threadId === null) return null;
  return (
    <>
      <IconAction command="fork-thread" size="sm" onClick={() => setOpen(true)} />
      {open && (
        <ForkDialog
          point={point}
          defaultTitle={extras.state.summary?.title ?? ""}
          onOpenChange={setOpen}
        />
      )}
    </>
  );
}

function ForkDialog({
  point,
  defaultTitle,
  onOpenChange,
}: {
  readonly point: ForkPoint;
  readonly defaultTitle: string;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const extras = useKobeExtras();
  const session = useChatSession();
  const openThread = useContext(OpenThreadContext);
  const [title, setTitle] = useState(defaultTitle);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const controller = extras?.controller;
    if (pending || !controller) return;
    setPending(true);
    setError(null);
    try {
      const name = title.trim();
      const res = await controller.fork({
        entryId: point.entryId,
        ...(name === "" ? {} : { title: name }),
      });
      if (!res.ok) {
        setError(res.error.message);
        return;
      }
      onOpenChange(false);
      // Forked at a prompt: it waits in the new thread's composer, to edit or send.
      if (point.draft) session.setComposerDraft(res.data.threadId, point.draft);
      session.threadCreated(); // the list reads again: the fork is yours
      openThread?.(res.data.threadId);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={onOpenChange}>
      <Dialog.Portal container={chatPortalContainer()}>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content
          className="bg-background text-foreground fixed top-1/2 left-1/2 z-50 grid w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-3 rounded-lg border p-5 shadow-lg"
          data-fork-dialog
        >
          <Dialog.Title className="m-0 text-base font-semibold">Fork to a new thread</Dialog.Title>
          <Dialog.Description className="text-muted-foreground m-0 text-sm">
            {point.draft === undefined
              ? "The new thread starts with this conversation up to this answer and continues on its own."
              : "The new thread starts with this conversation up to just before this message, which waits in its message box for you to edit or send."}{" "}
            Attached files are not copied. This thread stays as it is.
          </Dialog.Description>
          <form onSubmit={(e) => void submit(e)} className="grid gap-3">
            <label className="grid gap-1 text-sm">
              <span>Title of the new thread</span>
              <input
                type="text"
                value={title}
                maxLength={THREAD_TITLE_MAX}
                disabled={pending}
                autoFocus
                onChange={(e) => setTitle(e.target.value)}
                className="border-input rounded-md border px-3 py-2"
              />
            </label>
            {error !== null && (
              <p role="alert" className="text-destructive m-0 text-sm">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button type="submit" disabled={pending}>
                {pending ? "Forking…" : "Fork"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
