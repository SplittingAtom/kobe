"use client";

import { useState, type FormEvent } from "react";
import { Dialog } from "radix-ui";
import { THREAD_COMPACT_FOCUS_MAX_CHARS } from "@kobe/protocol";
import type { ThreadController } from "../../lib/chat/thread-controller";
import { Button } from "../ui/button";

/**
 * Compact now (CE15, KOBE-213): asks Pi to summarize the conversation's older part, with an
 * optional one-line focus ("keep the SQL and the final numbers"). Pi writes the summary; the
 * conversation then shows it as a "context compacted" marker. A refusal shows the server's message
 * (one fixed text per code); the dialog stays open while Pi works and can be closed meanwhile.
 */
export function CompactDialog({
  controller,
  open,
  onOpenChange,
}: {
  readonly controller: Pick<ThreadController, "compact">;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [focus, setFocus] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = (next: boolean) => {
    if (!next) setError(null);
    onOpenChange(next);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const trimmed = focus.trim();
      const res = await controller.compact(trimmed === "" ? undefined : focus);
      if (res.ok) {
        setFocus("");
        onOpenChange(false);
      } else {
        setError(res.error.message);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={change}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content
          className="bg-background text-foreground fixed top-1/2 left-1/2 z-50 grid w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-3 rounded-lg border p-5 shadow-lg"
          data-compact-dialog
        >
          <Dialog.Title className="m-0 text-base font-semibold">Compact this thread</Dialog.Title>
          <Dialog.Description className="text-muted-foreground m-0 text-sm">
            The agent summarizes the older part of this conversation to free up context. Recent
            messages stay as they are, and the summary appears in the conversation.
          </Dialog.Description>
          <form onSubmit={(e) => void submit(e)} className="grid gap-3">
            <label className="grid gap-1 text-sm">
              <span>What should the summary keep? (optional)</span>
              <input
                type="text"
                value={focus}
                maxLength={THREAD_COMPACT_FOCUS_MAX_CHARS}
                placeholder="keep the SQL and the final numbers"
                disabled={pending}
                onChange={(e) => setFocus(e.target.value)}
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
                  {pending ? "Close" : "Cancel"}
                </Button>
              </Dialog.Close>
              <Button type="submit" disabled={pending}>
                {pending ? "Compacting…" : "Compact now"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
