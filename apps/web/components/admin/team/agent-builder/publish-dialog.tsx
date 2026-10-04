import { useEffect, useRef, type KeyboardEvent } from "react";
import {
  publishTeamAgent,
  type AgentDetail,
  type AgentDetailSaved,
} from "../../../../lib/admin/api/team/agent-builder";
import { ErrorNotice } from "../../error-notice";
import { useMutation } from "../../use-resource";
import styles from "./agent-builder.module.css";

const FOCUSABLE = "button:not([disabled]), [href], input, select, textarea";

/**
 * Confirms a publish (modal, focus kept inside, Escape cancels). Publishes exactly the saved
 * draft revision (If-Match), so what the person reviewed is what goes out.
 */
export function PublishDialog({
  teamId,
  agent,
  warnings,
  onClose,
  onPublished,
}: {
  readonly teamId: string;
  readonly agent: AgentDetail;
  readonly warnings: readonly string[];
  readonly onClose: () => void;
  readonly onPublished: (result: AgentDetailSaved, version: number) => void;
}) {
  const mutation = useMutation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const next = (agent.currentVersion ?? 0) + 1;

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
  }, []);

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function publish() {
    let published: AgentDetailSaved | null = null;
    const done = await mutation.run(
      async () => {
        const res = await publishTeamAgent(teamId, agent);
        if (res.ok) published = res.data;
        return res;
      },
      () => null,
    );
    if (done && published) onPublished(published, next);
  }

  return (
    <div className={styles.backdrop}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="publish-title"
        aria-describedby="publish-body"
        className={styles.dialog}
        onKeyDown={onKeyDown}
      >
        <h2 id="publish-title">{`Publish ${agent.name} as v${next}`}</h2>
        <div id="publish-body">
          <p>
            This publishes draft revision {agent.revision}. New conversations use v{next}; existing
            ones stay on the version they started with. The tools the agent may use are frozen into
            the version.
          </p>
          {warnings.length > 0 && (
            <div className={styles.warnings}>
              <strong>Check before publishing</strong>
              <ul>
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        {mutation.error && <ErrorNotice error={mutation.error} />}
        <div className={styles.toolbar}>
          <button type="button" disabled={mutation.pending} onClick={() => void publish()}>
            {`Publish v${next}`}
          </button>
          <button type="button" data-initial-focus onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
