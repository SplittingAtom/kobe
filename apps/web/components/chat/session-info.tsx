"use client";

import { useAuiState } from "@assistant-ui/react";
import { Dialog } from "radix-ui";
import { useState } from "react";
import type { TeamModels } from "../../lib/admin/api/team/models";
import type { UsageTotals } from "../../lib/admin/api/usage";
import { formatTokens, formatUsd } from "../../lib/admin/usage-format";
import { apiTextFile } from "../../lib/api/client";
import { threadExportOneUrl } from "../../lib/chat/api";
import { aliasName, modelChoices, teamDefaultLabel } from "../../lib/chat/model-choices";
import { NO_THREAD } from "../../lib/chat/thread-commands";
import type { ThreadState } from "../../lib/chat/thread-state";
import { useBindCommands } from "../shell/command-bindings";
import { Button } from "../ui/button";
import { chatPortalContainer } from "../ui/chat-portal";
import { useChatSession, type KobeThreadExtras } from "./kobe-runtime";
import { useThreadUsageRead } from "./message-footer";
import {
  THINKING_LABELS,
  shownThinking,
  thinkingChoices,
  thinkingDefaultLabel,
} from "./thinking-picker";
import { useThreadTeamModels } from "./use-team-models";

const NOT_OWNER = "Only its owner can download this conversation.";
const DOWNLOAD_FAILED = {
  status: 0,
  code: "download_failed",
  message: "The download didn't finish. Try /export again.",
};
const ZERO: UsageTotals = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  unpricedCalls: 0,
  estimatedCalls: 0,
};

/** The conversation's model as its picker shows it, and its thinking level. */
function modelLines(
  models: TeamModels,
  state: ThreadState,
): { readonly model: string; readonly thinking: string } {
  const choices = modelChoices(models, state.summary?.model ?? null, state.agentModel ?? null);
  const alias = choices.pinned ?? choices.chosen;
  const model = alias === null ? teamDefaultLabel(choices) : aliasName(models, alias);
  const { levels, default: fallback } = thinkingChoices(models, alias);
  const level = shownThinking(state.summary?.thinkingLevel ?? null, levels);
  const thinking =
    levels.length === 0
      ? "Not offered by this model"
      : level === null
        ? thinkingDefaultLabel(fallback)
        : THINKING_LABELS[level];
  return { model, thinking };
}

const when = (iso: string | undefined) =>
  iso === undefined
    ? "—"
    : new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function sum(runs: readonly UsageTotals[]): UsageTotals {
  return runs.reduce<UsageTotals>(
    (acc, r) => ({
      calls: acc.calls + r.calls,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + r.cacheWriteTokens,
      costUsd: acc.costUsd + r.costUsd,
      unpricedCalls: acc.unpricedCalls + r.unpricedCalls,
      estimatedCalls: acc.estimatedCalls + r.estimatedCalls,
    }),
    ZERO,
  );
}

/**
 * `/session` (KOBE-450, Pi's /session): this conversation's details and usage, read from what the
 * server already sent (the thread, the team's models, `GET /v1/threads/{id}/usage`). Read-only.
 */
function SessionInfoDialog({
  extras,
  onOpenChange,
}: {
  readonly extras: KobeThreadExtras;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { state } = extras;
  const summary = state.summary;
  const models = useThreadTeamModels();
  const usage = useThreadUsageRead()?.usage;
  const messages = useAuiState((s) => s.thread.messages.length);
  const lines = models.status === "ready" ? modelLines(models.data, state) : null;
  const totals = sum(usage?.runs ?? []);
  const rows: readonly (readonly [string, string])[] = [
    ["Title", summary?.title || "Untitled conversation"],
    ["Agent", summary?.agentName ?? "No agent"],
    ["Model", lines?.model ?? "—"],
    ["Thinking", lines?.thinking ?? "—"],
    ["Started", when(summary?.createdAt)],
    ["Last activity", when(summary?.lastActivityAt)],
    ["Messages on screen", String(messages)],
    ["Runs", String(usage?.runs.length ?? 0)],
    ["Model calls", String(totals.calls)],
    [
      "Input tokens",
      formatTokens(totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens),
    ],
    ["Output tokens", formatTokens(totals.outputTokens)],
    [
      "Cost",
      totals.unpricedCalls > 0
        ? `${formatUsd(totals.costUsd)} (some calls unpriced)`
        : formatUsd(totals.costUsd),
    ],
  ];
  return (
    <Dialog.Root open onOpenChange={onOpenChange}>
      <Dialog.Portal container={chatPortalContainer()}>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" data-kobe-portal />
        <Dialog.Content
          className="bg-background text-foreground fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-3 overflow-y-auto rounded-lg border p-5 shadow-lg"
          data-session-info
          data-kobe-portal
        >
          <Dialog.Title className="m-0 text-base font-semibold">This conversation</Dialog.Title>
          <Dialog.Description className="text-muted-foreground m-0 text-sm">
            Its details and what its runs used so far.
          </Dialog.Description>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {rows.map(([term, value]) => (
              <div key={term} className="contents">
                <dt className="text-muted-foreground">{term}</dt>
                <dd className="m-0 min-w-0 break-words">{value}</dd>
              </div>
            ))}
          </dl>
          <div className="flex justify-end">
            <Dialog.Close asChild>
              <Button type="button" variant="outline">
                Close
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Saves `text` as `filename` through a short-lived object URL. */
function save(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.append(a);
  try {
    a.click();
  } finally {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * The open thread's `/session` and `/export` (KOBE-450, Pi's commands of those names). `/export`
 * downloads the conversation as Markdown from `GET /v1/threads/{id}/export`: the server decides
 * (the owner's only, in the active team) and audits it. A reader of a shared thread gets `/session`
 * only (the listings block the rest for readers).
 */
export function SessionCommands({
  extras,
  threadId,
}: {
  readonly extras: KobeThreadExtras;
  readonly threadId: string;
}) {
  const session = useChatSession();
  const [open, setOpen] = useState(false);
  const summary = extras.state.summary;
  const notOwner = summary?.readOnly === true ? NOT_OWNER : null;
  useBindCommands({
    "thread-info": { onSelect: () => setOpen(true) },
    "export-thread": {
      onSelect: () => {
        // Fetched rather than linked (review LOW-4): a refusal (busy, stale tab, gone) shows the
        // server's message in the thread's error banner instead of saving it as a file.
        void apiTextFile(threadExportOneUrl(threadId, session.teamId), {
          teamId: session.teamId,
        })
          .then((res) => {
            if (res.ok) save(res.data.text, res.data.filename ?? "conversation.md");
            else extras.controller?.reportError(res.error);
          })
          // The body can fail part way (the connection dropped): say so (review 450 LOW).
          .catch(() => extras.controller?.reportError(DOWNLOAD_FAILED));
      },
      blocker: notOwner ?? (summary === null ? NO_THREAD : null),
    },
  });
  return open ? <SessionInfoDialog extras={extras} onOpenChange={setOpen} /> : null;
}
