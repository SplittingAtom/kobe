import { Dialog } from "radix-ui";
import { useRef } from "react";
import {
  isEvalStarted,
  publishTeamAgent,
  type AgentDetail,
  type AgentDetailSaved,
  type AgentEval,
  type PublishedAgent,
  type EvalStarted,
} from "../../../../lib/admin/api/team/agent-builder";
import { Button, Notice } from "../../../ui/console";
import { consolePortalContainer } from "../../../ui/chat-portal";
import { ErrorNotice } from "../../error-notice";
import { useMutation } from "../../use-resource";

/** A control that can take focus back: still on the page and not disabled. */
function focusable(el: HTMLElement | null | undefined): el is HTMLElement {
  return !!el && el.isConnected && !el.matches(":disabled");
}

/**
 * Confirms a publish (Radix Dialog: modal, focus kept inside, starts on Cancel). Escape and Cancel
 * close it, an outside press doesn't, and nothing closes it while the publish is in flight, so a
 * refusal is always shown here. Publishes exactly the saved draft revision (If-Match), so what
 * the person reviewed is what goes out. Mounted while open; when it closes (Cancel, Escape, a
 * publish or a started evaluation), focus goes to `returnFocus()` once the focus trap lets go.
 */
export function PublishDialog({
  teamId,
  agent,
  warnings,
  onClose,
  onPublished,
  onEvaluating,
  returnFocus,
}: {
  readonly teamId: string;
  readonly agent: AgentDetail;
  readonly warnings: readonly string[];
  readonly onClose: () => void;
  /** `version` is the number the server assigned. */
  readonly onPublished: (result: AgentDetailSaved, version: number) => void;
  /** The team requires an Orbit eval first: it started, and publishing follows if it passes. */
  readonly onEvaluating: (evaluation: AgentEval) => void;
  /** Where focus goes when the dialog closes: the Publish button, or what stands for it. */
  readonly returnFocus: () => HTMLElement | null;
}) {
  const mutation = useMutation();
  const cancel = useRef<HTMLButtonElement>(null);
  const next = (agent.currentVersion ?? 0) + 1;

  async function publish() {
    await mutation.run(
      () => publishTeamAgent(teamId, agent),
      (answer: PublishedAgent | EvalStarted) => {
        if (isEvalStarted(answer)) onEvaluating(answer.eval);
        else onPublished(answer, answer.version.version);
        return null;
      },
    );
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !mutation.pending) onClose();
      }}
    >
      <Dialog.Portal container={consolePortalContainer()}>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-console-overlay" />
        <Dialog.Content
          data-slot="console-dialog"
          className="fixed top-1/2 left-1/2 z-50 box-border max-h-[calc(100dvh-2rem)] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-console-border bg-console-bg p-5 text-console-fg shadow-lg"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancel.current?.focus();
          }}
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            if (mutation.pending) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            // Runs as the dialog unmounts, after the trap has let go.
            const target = returnFocus();
            const to = focusable(target) ? target : document.getElementById("console-main");
            if (to) {
              event.preventDefault();
              to.focus();
            }
          }}
        >
          <Dialog.Title className="m-0 text-lg font-semibold">
            {`Publish ${agent.name} as v${next}`}
          </Dialog.Title>
          <Dialog.Description className="m-0 mt-2">
            This publishes draft revision {agent.revision}. New conversations use v{next}; existing
            ones stay on the version they started with. The tools the agent may use are frozen into
            the version. If your team requires an Orbit safety evaluation first, it runs now and the
            agent is published when it passes.
          </Dialog.Description>
          {warnings.length > 0 && (
            <Notice tone="warn" title="Check before publishing" className="mt-3">
              <ul className="m-0 mt-1 ps-5">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Notice>
          )}
          {mutation.error && <ErrorNotice error={mutation.error} />}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button ref={cancel} disabled={mutation.pending} onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" loading={mutation.pending} onClick={() => void publish()}>
              {`Publish v${next}`}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
