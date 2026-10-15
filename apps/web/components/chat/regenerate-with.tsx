"use client";

import { ActionBarMorePrimitive, useAui } from "@assistant-ui/react";
import { modelName, type TeamModel } from "../../lib/admin/api/team/models";
import { initialThreadState } from "../../lib/chat/thread-state";
import { IconAction } from "../shell/icon-action";
import { useKobeExtras } from "./kobe-runtime";
import { useTeamModels } from "./use-team-models";

const DRAFT_STATE = initialThreadState(null);

const ITEM =
  "hover:bg-muted focus:bg-muted flex cursor-pointer items-center rounded-md px-2 py-1.5 text-sm outline-none select-none";

/**
 * The team's enabled models to regenerate with, the thread's current one (its choice, else the
 * team default) first-class but marked; empty while loading, unreadable, or for a pinned agent.
 */
function useChoices(): { readonly models: readonly TeamModel[]; readonly current: string | null } {
  const extras = useKobeExtras();
  const loaded = useTeamModels(extras?.state ?? DRAFT_STATE);
  if (loaded.status !== "ready" || !extras || extras.state.agentModel != null) {
    return { models: [], current: null };
  }
  return {
    models: loaded.data.models.filter((m) => m.enabled),
    current: extras.state.summary?.model ?? loaded.data.default,
  };
}

/**
 * Regenerate's split half (CE17, KOBE-217): "Regenerate with…" lists the team's enabled models.
 * Choosing one switches the thread's model the way the picker does (CE17: the next turns use it
 * too; no one-off model per message), then regenerates this answer as a sibling. Pi records the
 * switch as a `model_change` entry on the new branch, so its marker shows above the new version.
 * A refused switch (`model_not_enabled`, the server's fixed text) shows in the thread's error
 * banner and nothing runs. The thread's current model regenerates without a switch. Hidden for a
 * pinned agent's thread (its model never changes) and when there is no model to list.
 */
export function RegenerateWith() {
  const aui = useAui();
  const extras = useKobeExtras();
  const { models, current } = useChoices();
  const controller = extras?.controller;
  if (!controller || models.length === 0) return null;

  const regenerateWith = async (alias: string) => {
    if (alias !== current && !(await controller.setModel(alias))) return;
    aui.message().reload();
  };

  return (
    <ActionBarMorePrimitive.Root>
      <ActionBarMorePrimitive.Trigger asChild>
        <IconAction command="regenerate-with" size="sm" />
      </ActionBarMorePrimitive.Trigger>
      <ActionBarMorePrimitive.Content
        align="start"
        sideOffset={4}
        className="bg-background z-50 min-w-44 rounded-lg border p-1 shadow-md"
      >
        {models.map((m) => (
          <ActionBarMorePrimitive.Item
            key={m.alias}
            className={ITEM}
            onSelect={() => void regenerateWith(m.alias)}
          >
            {modelName(m)}
            {m.alias === current ? " (current)" : ""}
          </ActionBarMorePrimitive.Item>
        ))}
      </ActionBarMorePrimitive.Content>
    </ActionBarMorePrimitive.Root>
  );
}
