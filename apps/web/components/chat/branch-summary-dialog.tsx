"use client";

import { useState, type FormEvent } from "react";
import { Dialog } from "radix-ui";
import { BRANCH_SUMMARY_FOCUS_MAX_CHARS } from "@kobe/protocol";
import type { ThreadController } from "../../lib/chat/thread-controller";
import { FILES_LEFT_NOTE } from "../../lib/chat/tree-panel";
import { Button } from "../ui/button";
import { chatPortalContainer } from "../ui/chat-portal";

/** What the dialog says will happen (CT11): the messages left behind, and the model call. */
export function carryText(left: number): string {
  const messages = left === 1 ? "the 1 message" : `the ${left} messages`;
  return (
    `Pi summarizes ${messages} on the branch you are leaving and puts the summary into the ` +
    "branch you switch to; it costs a model call."
  );
}

/**
 * Make it current and carry a summary (KOBE-548, CT11), like Compact now's dialog: what will
 * happen, an optional one-line focus, Go. The summary is Pi's; the conversation then shows it as
 * "Summary of another branch". A refusal shows the server's fixed message here (and, through the
 * controller, in the thread's error notice). Opened from the tree's node menu and the bar.
 */
export function BranchSummaryDialog({
  controller,
  target,
  left,
  filesLeft = false,
  open,
  onOpenChange,
  onDone,
}: {
  readonly controller: Pick<ThreadController, "carrySummary">;
  /** The entry the thread switches to (the branch's newest entry). */
  readonly target: string;
  /** Messages on the branch left that the target's branch does not have. */
  readonly left: number;
  /** CT6: the branch left wrote files (they stay in the workspace). */
  readonly filesLeft?: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The summary is the leaf now (the tree panel closes). */
  readonly onDone?: () => void;
}) {
  const [focus, setFocus] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = (next: boolean) => {
    setError(null);
    onOpenChange(next);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    const line = focus.trim();
    if (/[\r\n]/.test(line)) return setError("Keep the focus to one line.");
    setPending(true);
    setError(null);
    try {
      const res = await controller.carrySummary(target, line === "" ? undefined : line);
      if (res === undefined) setError("This branch can't be made current now.");
      else if (!res.ok) setError(res.error.message);
      else {
        setFocus("");
        onOpenChange(false);
        onDone?.();
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={change}>
      <Dialog.Portal container={chatPortalContainer()}>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" data-kobe-portal />
        <Dialog.Content
          className="bg-background text-foreground fixed top-1/2 left-1/2 z-50 grid w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-3 rounded-lg border p-5 shadow-lg"
          data-branch-summary-dialog
          data-kobe-portal
        >
          <Dialog.Title className="m-0 text-base font-semibold">
            Make it current and carry a summary
          </Dialog.Title>
          <Dialog.Description className="text-muted-foreground m-0 text-sm">
            {carryText(left)}
          </Dialog.Description>
          {filesLeft && <p className="text-muted-foreground m-0 text-sm">{FILES_LEFT_NOTE}</p>}
          <form onSubmit={(e) => void submit(e)} className="grid gap-3">
            <label className="grid gap-1 text-sm">
              <span>What should the summary keep? (optional)</span>
              <input
                type="text"
                value={focus}
                maxLength={BRANCH_SUMMARY_FOCUS_MAX_CHARS}
                placeholder="keep the colour decision"
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
                {pending ? "Summarizing…" : "Go"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
