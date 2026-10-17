"use client";

import type { ThinkingLevel } from "@kobe/protocol";
import { useId, useState, useSyncExternalStore } from "react";
import { modelName, type TeamModels } from "../../lib/admin/api/team/models";
import {
  aliasName,
  modelChoices,
  teamDefaultLabel,
  type ModelChoices,
} from "../../lib/chat/model-choices";
import type { ThreadController } from "../../lib/chat/thread-controller";
import { isBusy, type ThreadState } from "../../lib/chat/thread-state";
import type { MenuBinding } from "../../lib/shell/menu";
import { useBindCommands } from "../shell/command-bindings";
import { useChatSession } from "./kobe-runtime";
import { ThinkingPicker } from "./thinking-picker";
import { useThreadTeamModels } from "./use-team-models";
import styles from "./chat.module.css";

/** The `<select>` value of "use the team's default" (an alias is never empty). */
const DEFAULT = "";

/**
 * `/model` (KOBE-224): the picker's own choices and `choose`, or why it can't change now.
 */
function modelBinding(
  models: TeamModels,
  choices: ModelChoices,
  blocker: string | null,
  choose: (value: string) => void,
): MenuBinding {
  const { enabled, chosen, pinned } = choices;
  if (pinned !== null) {
    return { choices: [], blocker: `This agent always uses ${aliasName(models, pinned)}.` };
  }
  if (enabled.length === 0 && chosen === null) {
    return { choices: [], blocker: "No models are enabled for your team yet." };
  }
  return {
    blocker,
    choices: [
      { key: DEFAULT, label: teamDefaultLabel(choices), current: chosen === null },
      ...enabled.map((m) => ({ key: m.alias, label: modelName(m), current: m.alias === chosen })),
    ].map((c) => ({ ...c, onSelect: () => choose(c.key) })),
  };
}

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
  const [draftThinking, setDraftThinking] = useState<ThinkingLevel | null>(
    () => session.draftThinking,
  );
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
  // KOBE-260: the conversation's thinking level, kept like the model on a new conversation.
  const chooseThinking = (level: ThinkingLevel | null) => {
    if (isNew) {
      setDraftThinking(level);
      session.setDraftThinking(level);
      return;
    }
    void controller?.setThinkingLevel(level);
  };
  const thinkingChosen = isNew ? draftThinking : (state.summary?.thinkingLevel ?? null);
  const thinkingDisabled =
    state.summary?.deletedAt != null || isBusy(state, "thinking") || (!isNew && !controller);
  // The agent's pinned model wins over the conversation's choice (user decision, KOBE-44): the
  // picker shows it, locked. The pin comes from the server's agent resolver (KOBE-47 seam).
  const agentModel = isNew ? (draftAgent?.model ?? null) : (state.agentModel ?? null);
  const all =
    loaded.status === "ready"
      ? modelChoices(loaded.data, isNew ? draft : (state.summary?.model ?? null), agentModel)
      : undefined;
  useBindCommands(
    loaded.status === "ready" && all
      ? {
          "choose-model": modelBinding(
            loaded.data,
            all,
            disabled ? "The model can't be changed right now." : null,
            choose,
          ),
        }
      : {},
  );

  if (loaded.status !== "ready" || all === undefined) return null;
  const choices = all;
  const { enabled, chosen, unavailable, pinned } = choices;
  const chosenName = chosen === null ? null : aliasName(loaded.data, chosen);

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
        <ThinkingPicker
          models={loaded.data}
          alias={pinned}
          chosen={thinkingChosen}
          disabled={thinkingDisabled}
          onChoose={chooseThinking}
        />
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
      {!unavailable && (
        <ThinkingPicker
          models={loaded.data}
          alias={chosen}
          chosen={thinkingChosen}
          disabled={thinkingDisabled}
          onChoose={chooseThinking}
        />
      )}
      {unavailable && (
        <p id={`${id}-unavailable`} role="alert" className={styles.modelWarning}>
          {chosenName} isn&apos;t enabled for your team any more, so messages here can&apos;t run.
          Pick another model, or ask a team admin to enable it.
        </p>
      )}
    </>
  );
}
