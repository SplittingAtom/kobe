"use client";

import { useEffect, useId, useState } from "react";
import { modelName, type TeamModels } from "../../lib/admin/api/team/models";
import type { ThreadController } from "../../lib/chat/thread-controller";
import { isBusy, type ThreadState } from "../../lib/chat/thread-state";
import { useChatSession } from "./kobe-runtime";
import styles from "./chat.module.css";

/** The `<select>` value of "use the team's default" (an alias is never empty). */
const DEFAULT = "";

type Loaded =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: TeamModels }
  | { readonly status: "unavailable" };

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
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [draft, setDraft] = useState<string | null>(() => session.draftModel);

  // Read again for each conversation opened (cached briefly by the session).
  useEffect(() => {
    let current = true;
    session.models().then(
      (res) => {
        if (current)
          setLoaded(res.ok ? { status: "ready", data: res.data } : { status: "unavailable" });
      },
      () => {
        if (current) setLoaded({ status: "unavailable" });
      },
    );
    return () => {
      current = false;
    };
  }, [session, state.threadId]);

  // A run refused for a disabled model: read the team's models again so the picker shows it.
  const terminal = state.live?.terminal;
  const failedForModel =
    terminal?.type === "run.failed" && terminal.payload.error.code === "agent_model_not_enabled";
  useEffect(() => {
    if (!failedForModel) return;
    let current = true;
    void session.models({ fresh: true }).then((res) => {
      if (current && res.ok) setLoaded({ status: "ready", data: res.data });
    });
    return () => {
      current = false;
    };
  }, [session, failedForModel]);

  if (loaded.status !== "ready") return null;
  const { models, default: teamDefault } = loaded.data;
  const enabled = models.filter((m) => m.enabled);
  const chosen = isNew ? draft : (state.summary?.model ?? null);
  const unavailable = chosen !== null && !enabled.some((m) => m.alias === chosen);
  const chosenModel = models.find((m) => m.alias === chosen);
  const defaultModel = models.find((m) => m.alias === teamDefault && m.enabled);
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
          <option value={DEFAULT}>
            {defaultModel ? `Team default (${modelName(defaultModel)})` : "Team default"}
          </option>
          {enabled.map((m) => (
            <option key={m.alias} value={m.alias}>
              {modelName(m)}
            </option>
          ))}
          {unavailable && (
            <option value={chosen}>
              {chosenModel ? modelName(chosenModel) : chosen} (unavailable)
            </option>
          )}
        </select>
      </label>
      {unavailable && (
        <p id={`${id}-unavailable`} role="alert" className={styles.modelWarning}>
          {chosenModel ? modelName(chosenModel) : chosen} isn&apos;t enabled for your team any more,
          so messages here can&apos;t run. Pick another model, or ask a team admin to enable it.
        </p>
      )}
    </>
  );
}
