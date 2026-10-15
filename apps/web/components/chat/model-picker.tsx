"use client";

import { useId, useState, useSyncExternalStore } from "react";
import { modelName } from "../../lib/admin/api/team/models";
import { aliasName, modelChoices, teamDefaultLabel } from "../../lib/chat/model-choices";
import type { ThreadController } from "../../lib/chat/thread-controller";
import { isBusy, type ThreadState } from "../../lib/chat/thread-state";
import { useChatSession } from "./kobe-runtime";
import { useThreadTeamModels } from "./use-team-models";
import styles from "./chat.module.css";

/** The `<select>` value of "use the team's default" (an alias is never empty). */
const DEFAULT = "";

/**
 * The conversation's model (D30; KOBE-41's open question): one of the team's enabled models, or
 * the team default. Sits in the composer's action bar, like assistant-ui's model selector, as a
 * native `<select>` (keyboard and screen readers for free). On a new conversation the choice is
 * kept until the first message creates the thread; on an existing one it is saved on the thread
 * and used by its next runs. A choice the team has since disabled stays selected, marked
 * unavailable, with the way out.
 */
export function ModelPicker({
  controller,
  state,
  isNew,
}: {
  readonly controller: ThreadController | null;
  readonly state: ThreadState;
  readonly isNew: boolean;
}) {
  const id = useId();
  const session = useChatSession();
  const loaded = useThreadTeamModels();
  const draftAgent = useSyncExternalStore(
    session.subscribeDraftAgent,
    () => session.draftAgent,
    () => null,
  );
  const [draft, setDraft] = useState<string | null>(() => session.draftModel);

  if (loaded.status !== "ready") return null;
  // The agent's pinned model wins over the conversation's choice (user decision, KOBE-44): the
  // picker shows it, locked. The pin comes from the server's agent resolver (KOBE-47 seam).
  const agentModel = isNew ? (draftAgent?.model ?? null) : (state.agentModel ?? null);
  const choices = modelChoices(
    loaded.data,
    isNew ? draft : (state.summary?.model ?? null),
    agentModel,
  );
  const { enabled, chosen, unavailable, pinned } = choices;
  const chosenName = chosen === null ? null : aliasName(loaded.data, chosen);
  const disabled =
    state.summary?.deletedAt != null || isBusy(state, "model") || (!isNew && !controller);

  const choose = (value: string) => {
    const model = value === DEFAULT ? null : value;
    if (isNew) {
      setDraft(model);
      session.setDraftModel(model);
      return;
    }
    void controller?.setModel(model);
  };

  if (pinned !== null) {
    const name = aliasName(loaded.data, pinned);
    return (
      <>
        <label className={styles.modelPicker}>
          <span className={styles.visuallyHidden}>Model for this conversation</span>
          <select value={pinned} disabled aria-describedby={`${id}-pinned`}>
            <option value={pinned}>{name}</option>
          </select>
        </label>
        <span id={`${id}-pinned`} className={styles.hint}>
          This agent always uses {name}.
        </span>
      </>
    );
  }

  if (enabled.length === 0 && chosen === null) {
    return (
      <span className={styles.hint} id={`${id}-none`}>
        No models are enabled for your team yet.
      </span>
    );
  }

  return (
    <>
      <label className={styles.modelPicker}>
        <span className={styles.visuallyHidden}>Model for this conversation</span>
        <select
          value={chosen ?? DEFAULT}
          disabled={disabled}
          aria-invalid={unavailable || undefined}
          aria-describedby={unavailable ? `${id}-unavailable` : undefined}
          onChange={(e) => choose(e.target.value)}
        >
          <option value={DEFAULT}>{teamDefaultLabel(choices)}</option>
          {enabled.map((m) => (
            <option key={m.alias} value={m.alias}>
              {modelName(m)}
            </option>
          ))}
          {unavailable && chosen !== null && (
            <option value={chosen}>{chosenName} (unavailable)</option>
          )}
        </select>
      </label>
      {unavailable && (
        <p id={`${id}-unavailable`} role="alert" className={styles.modelWarning}>
          {chosenName} isn&apos;t enabled for your team any more, so messages here can&apos;t run.
          Pick another model, or ask a team admin to enable it.
        </p>
      )}
    </>
  );
}
