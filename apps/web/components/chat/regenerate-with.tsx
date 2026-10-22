"use client";

import { ActionBarMorePrimitive, useAuiState } from "@assistant-ui/react";
import { useRef } from "react";
import { modelName } from "../../lib/admin/api/team/models";
import { modelChoices, teamDefaultLabel } from "../../lib/chat/model-choices";
import { canRegenerateWith } from "../../lib/chat/thread-state";
import { branchPoint } from "../../lib/chat/tree";
import { IconAction } from "../shell/icon-action";
import { chatPortalContainer } from "../ui/chat-portal";
import { useKobeExtras } from "./kobe-runtime";
import { useThreadTeamModels } from "./use-team-models";

const ITEM =
  "hover:bg-muted focus:bg-muted flex cursor-pointer items-center rounded-md px-2 py-1.5 text-sm outline-none select-none";

const CURRENT = " (current)";

/**
 * Regenerate's split half (CE17, KOBE-217): "Regenerate with…" lists the team default and the
 * team's enabled models, the conversation's current choice marked. Choosing one saves it on the
 * thread the way the picker does (CE17: the next turns use it too; the team default stays "follow
 * the default", never its alias), then regenerates this answer as a sibling from the same branch
 * point as Regenerate (`ThreadController.regenerateWith`). Pi records the switch as a
 * `model_change` entry on the new branch, so its marker shows above the new version.
 *
 * Offered once the thread is read, disabled whenever plain Regenerate is (a run going or queued,
 * a message being sent, Trash) and while a model change is in flight; hidden for a pinned agent's
 * thread (its model never changes) and while the team's models are unknown.
 */
export function RegenerateWith() {
  const extras = useKobeExtras();
  const loaded = useThreadTeamModels();
  const parentId = useAuiState((s) => s.message.parentId);
  const pending = useRef(false);
  const controller = extras?.controller;
  const state = extras?.state;
  if (!controller || !state?.summary || loaded.status !== "ready") return null;
  const choices = modelChoices(loaded.data, state.summary.model ?? null, state.agentModel ?? null);
  if (choices.pinned !== null || choices.enabled.length === 0) return null;
  const ready = canRegenerateWith(state);

  const choose = (model: string | null) => {
    const point = branchPoint(extras.projection, parentId);
    if (pending.current || !ready || point === undefined) return;
    pending.current = true;
    controller
      .regenerateWith(model, point.text, point.parentEntryId, point.promptEntryId)
      .catch(() => controller.reportError(NOT_SENT))
      .finally(() => {
        pending.current = false;
      });
  };

  const options = [
    { key: "", model: null, name: teamDefaultLabel(choices) },
    ...choices.enabled.map((m) => ({ key: m.alias, model: m.alias, name: modelName(m) })),
  ];
  return (
    <ActionBarMorePrimitive.Root>
      <ActionBarMorePrimitive.Trigger asChild disabled={!ready}>
        <IconAction command="regenerate-with" size="sm" />
      </ActionBarMorePrimitive.Trigger>
      {/* In the chat root, where the preflight slice applies (KOBE-282); the tokens are global. */}
      <ActionBarMorePrimitive.Content
        portalProps={{ container: chatPortalContainer() }}
        align="start"
        sideOffset={4}
        className="bg-background z-50 min-w-44 rounded-lg border p-1 shadow-md"
      >
        {options.map((o) => (
          <ActionBarMorePrimitive.Item
            key={o.key}
            className={ITEM}
            disabled={!ready}
            onSelect={() => choose(o.model)}
          >
            {o.name}
            {o.model === choices.chosen ? CURRENT : ""}
          </ActionBarMorePrimitive.Item>
        ))}
      </ActionBarMorePrimitive.Content>
    </ActionBarMorePrimitive.Root>
  );
}

const NOT_SENT = {
  status: 0,
  code: "client_error",
  message: "The answer could not be regenerated. Try again.",
} as const;
