"use client";

import { useAuiState } from "@assistant-ui/react";
import { useMemo, useState } from "react";
import type { AppResultView } from "../../lib/apps/app-results";
import { approvalKey, runToolKey } from "../../lib/chat/markers";
import type { KobeMessageMeta } from "../../lib/chat/tree";
import { useKobeExtras } from "../chat/kobe-runtime";
import { useThreadApps, type ThreadApps } from "./thread-apps";

/** Where this message's tool calls look their app results up (KOBE-438, KOBE-445). */
export interface AppWhere {
  readonly prompt: string | undefined;
  readonly liveRunId: string | undefined;
}

export function useAppWhere(): AppWhere {
  const meta = useAuiState((s) => s.message.metadata.custom as KobeMessageMeta | undefined);
  const runId = useKobeExtras()?.state.live?.runId;
  const assistant = meta?.kind === "assistant" ? meta : undefined;
  return { prompt: assistant?.promptEntryId, liveRunId: assistant?.live ? runId : undefined };
}

export function lookupAppResult(
  apps: ThreadApps,
  where: AppWhere,
  toolCallId: string,
): AppResultView | undefined {
  const byPrompt =
    where.prompt === undefined
      ? undefined
      : apps.byPrompt.get(approvalKey(where.prompt, toolCallId));
  const byRun =
    where.liveRunId === undefined
      ? undefined
      : apps.byRun.get(runToolKey(where.liveRunId, toolCallId));
  // The thread's only result for this call (KOBE-445): never depends on the prompt's ancestry.
  return byPrompt ?? byRun ?? apps.byTool.get(toolCallId);
}

/**
 * What a tool card shows of its MCP App for this viewer (KOBE-608): the app (`app`), the app on
 * its way (`pending`: the live result carried a marker, the list does not have it yet), the text
 * card (`text`, MA10), an app whose stored result could not be read (`failed`), or none.
 */
export type AppCallStatus = "app" | "pending" | "text" | "failed" | "none";

export function appCallStatus(
  view: AppResultView | undefined,
  hasMarker: boolean,
  failed: ReadonlySet<string>,
): AppCallStatus {
  if (view === undefined) return hasMarker ? "pending" : "none";
  if (view.view !== "app") return "text";
  return failed.has(view.resultRef) ? "failed" : "app";
}

const SEP = "\u0000";

/**
 * KOBE-608: the tool calls of this answer that render an MCP App frame for this viewer, or null
 * when none does (the answer renders as before). Decided from what the tool card itself uses (the
 * thread's app list and the live result's marker), never from the frame's load event, except
 * that a stored result that could not be read falls back. Once an app showed, it stays an app
 * answer until the server says otherwise (text card or a failed read): a list being re-read never
 * flickers the rest of the answer into view.
 */
export function useAppAnswer(): ReadonlySet<string> | null {
  const apps = useThreadApps();
  const where = useAppWhere();
  const tools = useKobeExtras()?.state.live?.tools;
  const ids = useAuiState((s) =>
    s.message.content
      .flatMap((part) =>
        part.type === "tool-call" && part.toolName.startsWith("mcp__") ? [part.toolCallId] : [],
      )
      .join(SEP),
  );
  const failed = apps?.failed ?? NO_FAILED;
  const statuses = (ids === "" ? [] : ids.split(SEP)).map((id) => ({
    id,
    status: appCallStatus(
      apps ? lookupAppResult(apps, where, id) : undefined,
      tools?.[id]?.result?.app !== undefined,
      failed,
    ),
  }));
  const shown = statuses
    .filter((s) => s.status === "app" || s.status === "pending")
    .map((s) => s.id)
    .join(SEP);
  const settled = statuses.some((s) => s.status === "text" || s.status === "failed");
  // The last app answer seen (derived state, updated while rendering).
  // The last app answer seen for this message (derived state, updated while rendering); the
  // branch picker can swap the message under the same component.
  const messageId = useAuiState((s) => s.message.id);
  const [held, setHeld] = useState({ messageId, shown: "" });
  const last = held.messageId === messageId ? held.shown : "";
  if (shown !== "" && shown !== last) setHeld({ messageId, shown });
  if (shown === "" && settled && last !== "") setHeld({ messageId, shown: "" });
  const effective = shown !== "" ? shown : settled ? "" : last;
  return useMemo(() => (effective === "" ? null : new Set(effective.split(SEP))), [effective]);
}

const NO_FAILED: ReadonlySet<string> = new Set();
