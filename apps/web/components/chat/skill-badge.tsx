"use client";

import { useAuiState } from "@assistant-ui/react";
import { SparklesIcon } from "lucide-react";
import { approvalKey, runToolKey, type SkillMarker } from "../../lib/chat/markers";
import type { KobeMessageMeta } from "../../lib/chat/tree";
import { useKobeExtras } from "./kobe-runtime";
import { useMarkerData } from "./markers";

/**
 * Skill use in the chat (KOBE-297). The server records a use when a run reads one of its own
 * skills' SKILL.md, and lists it in the thread's markers (`GET /v1/threads/{id}/markers`); the
 * chat never guesses from the path. A past answer finds its uses by its prompt entry and the tool
 * call; the live answer, whose prompt may not be in the tree yet, by the live run.
 */

interface Where {
  readonly prompt: string | undefined;
  /** Set only for the live answer. */
  readonly liveRunId: string | undefined;
}

function useWhere(): Where {
  const meta = useAuiState((s) => s.message.metadata.custom as KobeMessageMeta | undefined);
  const runId = useKobeExtras()?.state.live?.runId;
  const assistant = meta?.kind === "assistant" ? meta : undefined;
  return {
    prompt: assistant?.promptEntryId,
    liveRunId: assistant?.live ? runId : undefined,
  };
}

function lookup(
  data: ReturnType<typeof useMarkerData>,
  where: Where,
  toolCallId: string,
): SkillMarker | undefined {
  const byPrompt =
    where.prompt === undefined ? undefined : data.skills.get(approvalKey(where.prompt, toolCallId));
  if (byPrompt !== undefined || where.liveRunId === undefined) return byPrompt;
  return data.skillsByRun.get(runToolKey(where.liveRunId, toolCallId));
}

/** The skill this tool call loaded, if the server recorded one. */
export function useSkillOfToolCall(toolCallId: string): SkillMarker | undefined {
  return lookup(useMarkerData(), useWhere(), toolCallId);
}

/** "Used skill: <name>" on an answer, once per skill its steps loaded. */
export function UsedSkills() {
  const data = useMarkerData();
  const where = useWhere();
  const ids = useAuiState((s) =>
    s.message.content
      .flatMap((part) => (part.type === "tool-call" ? [part.toolCallId] : []))
      .join("\u0000"),
  );
  if (ids === "" || data.skills.size === 0) return null;
  const names = [
    ...new Set(
      ids.split("\u0000").flatMap((id) => {
        const skill = lookup(data, where, id);
        return skill ? [skill.semver ? `${skill.name} ${skill.semver}` : skill.name] : [];
      }),
    ),
  ];
  if (names.length === 0) return null;
  return (
    <ul
      aria-label="Skills used"
      data-kobe-used-skills
      className="text-muted-foreground m-0 flex list-none flex-wrap items-center gap-1.5 p-0 text-xs"
    >
      {names.map((name) => (
        <li key={name} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5">
          <SparklesIcon aria-hidden className="size-3" />
          <span>{`Used skill: ${name}`}</span>
        </li>
      ))}
    </ul>
  );
}
