"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { TeamModels } from "../../lib/admin/api/team/models";
import type { ThreadState } from "../../lib/chat/thread-state";
import { useChatSession, useKobeExtras } from "./kobe-runtime";

export type TeamModelsLoad =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: TeamModels }
  | { readonly status: "unavailable" };

/**
 * The team's models (`GET /v1/team/models`, cached briefly by the session) for the conversation on
 * screen. Read again for each conversation opened, and fresh when a run was refused because its
 * model was disabled (`agent_model_not_enabled`), so every reader shows the change.
 */
function useTeamModels(state: ThreadState | undefined): TeamModelsLoad {
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
  }, [session, state?.threadId]);

  const terminal = state?.live?.terminal;
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

const TeamModelsContext = createContext<TeamModelsLoad>({ status: "loading" });

/**
 * Loads the team's models once for the conversation on screen (not once per reader: the picker,
 * the context gauge and every answer's "Regenerate with…" menu, KOBE-217, share this read).
 */
export function TeamModelsProvider({ children }: { readonly children: ReactNode }) {
  const loaded = useTeamModels(useKobeExtras()?.state);
  return <TeamModelsContext.Provider value={loaded}>{children}</TeamModelsContext.Provider>;
}

/** The team's models for the conversation on screen (`TeamModelsProvider`). */
export function useThreadTeamModels(): TeamModelsLoad {
  return useContext(TeamModelsContext);
}
