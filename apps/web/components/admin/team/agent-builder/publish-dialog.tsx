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

/**
 * Confirms a publish (Radix Dialog: modal, focus kept inside, Escape cancels; it starts on
 * Cancel). Publishes exactly the saved draft revision (If-Match), so what the person reviewed is
 * what goes out. Mounted while open; the builder moves focus back to its Publish button.
 */
export function PublishDialog({
  teamId,
  agent,
  warnings,
  onClose,
  onPublished,
  onEvaluating,
}: {
  readonly teamId: string;
  readonly agent: AgentDetail;
  readonly warnings: readonly string[];
  readonly onClose: () => void;
  /** `version` is the number the server assigned. */
  readonly onPublished: (result: AgentDetailSaved, version: number) => void;
  /** The team requires an Orbit eval first: it started, and publishing follows if it passes. */
  readonly onEvaluating: (evaluation: AgentEval) => void;
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
        if (!open) onClose();
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
          // The builder focuses its Publish button itself (onClose).
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <Dialog.Title className="m-0 text-lg font-semibold">
            {`Publish ${agent.name} as v${next}`}
          </Dialog.Title>
          <Dialog.Description asChild>
            <div className="mt-2">
              <p className="m-0">
                This publishes draft revision {agent.revision}. New conversations use v{next};
                existing ones stay on the version they started with. The tools the agent may use are
                frozen into the version. If your team requires an Orbit safety evaluation first, it
                runs now and the agent is published when it passes.
              </p>
              {warnings.length > 0 && (
                <Notice tone="warn" title="Check before publishing" className="mt-3">
                  <ul className="m-0 mt-1 ps-5">
                    {warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </Notice>
              )}
            </div>
          </Dialog.Description>
          {mutation.error && <ErrorNotice error={mutation.error} />}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button ref={cancel} onClick={onClose}>
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
