"use client";

import { createContext, useContext, useState, type FormEvent } from "react";
import { Dialog } from "radix-ui";
import { forkEntryOf } from "../../lib/chat/fork";
import type { KobeMessageMeta } from "../../lib/chat/tree";
import { IconAction } from "../shell/icon-action";
import { Button } from "../ui/button";
import { useChatSession, useKobeExtras } from "./kobe-runtime";

/** Same limit as the server's thread titles. */
const TITLE_MAX = 200;

/** Opens a thread in the chat (the `?thread=` URL); provided by `ThreadView`. */
export const OpenThreadContext = createContext<((threadId: string) => void) | undefined>(undefined);

/**
 * "Fork to a new thread" on a message (CE16, KOBE-216): asks for a title, then the server copies
 * the conversation up to this message into a new thread of yours in the same project and opens
 * it. Shown for committed messages only (a pending prompt or a live answer has no entry yet).
 */
export function ForkAction({ meta }: { readonly meta: KobeMessageMeta | undefined }) {
  const [open, setOpen] = useState(false);
  const extras = useKobeExtras();
  const entryId = forkEntryOf(meta);
  if (entryId === undefined || !extras?.controller || extras.state.threadId === null) return null;
  return (
    <>
      <IconAction command="fork-thread" size="sm" onClick={() => setOpen(true)} />
      {open && (
        <ForkDialog
          entryId={entryId}
          defaultTitle={extras.state.summary?.title ?? ""}
          onOpenChange={setOpen}
        />
      )}
    </>
  );
}

function ForkDialog({
  entryId,
  defaultTitle,
  onOpenChange,
}: {
  readonly entryId: string;
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
      const res = await controller.fork({ entryId, ...(name === "" ? {} : { title: name }) });
      if (!res.ok) {
        setError(res.error.message);
        return;
      }
      onOpenChange(false);
      session.threadCreated(); // the list reads again: the fork is yours
      openThread?.(res.data.threadId);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content
          className="bg-background text-foreground fixed top-1/2 left-1/2 z-50 grid w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-3 rounded-lg border p-5 shadow-lg"
          data-fork-dialog
        >
          <Dialog.Title className="m-0 text-base font-semibold">Fork to a new thread</Dialog.Title>
          <Dialog.Description className="text-muted-foreground m-0 text-sm">
            The new thread starts with this conversation up to this message and continues on its
            own. This thread stays as it is.
          </Dialog.Description>
          <form onSubmit={(e) => void submit(e)} className="grid gap-3">
            <label className="grid gap-1 text-sm">
              <span>Title of the new thread</span>
              <input
                type="text"
                value={title}
                maxLength={TITLE_MAX}
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
