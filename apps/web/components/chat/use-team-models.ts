"use client";

import { useEffect, useState } from "react";
import type { TeamModels } from "../../lib/admin/api/team/models";
import type { ThreadState } from "../../lib/chat/thread-state";
import { useChatSession } from "./kobe-runtime";

export type TeamModelsLoad =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: TeamModels }
  | { readonly status: "unavailable" };

/**
 * The team's models (`GET /v1/team/models`, cached briefly by the session) for the conversation on
 * screen: the model picker and the context gauge (KOBE-211) share it. Read again for each
 * conversation opened, and fresh when a run was refused because its model was disabled
 * (`agent_model_not_enabled`), so both show the change.
 */
export function useTeamModels(state: ThreadState): TeamModelsLoad {
  const session = useChatSession();
  const [loaded, setLoaded] = useState<TeamModelsLoad>({ status: "loading" });

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

  return loaded;
}
