"use client";

import { AuiIf, SuggestionPrimitive, ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import { ArrowDownIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button";
import { Skeleton } from "../ui/skeleton";
import { isThreadRunning, type ThreadState } from "../../lib/chat/thread-state";
import { ErrorNotice } from "../admin/error-notice";
import { AgentPicker, useAgentName } from "./agent-picker";
import { Composer } from "./composer";
import { useChatSession, useKobeExtras } from "./kobe-runtime";
import { AssistantMessage, EditComposer, UserMessage } from "./messages";
import { RunPanel } from "./run-panel";

function statusLabel(state: ThreadState): string | undefined {
  if (state.summary?.deletedAt != null) return "In Trash";
  if (isThreadRunning(state)) return "Running";
  if (state.interruptedRun !== null || state.summary?.status === "interrupted")
    return "Interrupted";
  return undefined;
}

const COMPOSER_VARS = { "--thread-max-width": "44rem" } as React.CSSProperties;

function ThreadWelcome() {
  return (
    <div className="mb-6 flex flex-col px-2">
      <p className="animate-in fade-in slide-in-from-bottom-1 fill-mode-both text-2xl font-medium tracking-tight duration-200">
        How can I help you today?
      </p>
      <p className="text-muted-foreground animate-in fade-in fill-mode-both mt-2 text-sm duration-300">
        Ask the agent anything. It works in your own isolated workspace, and every tool it uses
        follows your team&apos;s policy.
      </p>
    </div>
  );
}

/** Suggestions fill the composer; the person reviews the text and sends it (nothing is sent for them). */
function ThreadSuggestions() {
  return (
    <div className="flex w-full flex-col">
      <ThreadPrimitive.Suggestions>
        {() => (
          <div className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-200">
            <SuggestionPrimitive.Trigger asChild>
              <button
                type="button"
                className="group hover:bg-foreground/[0.03] focus-visible:ring-ring/50 flex w-full items-baseline gap-2.5 rounded-md border-0 bg-transparent px-2 py-2 text-start text-sm transition-colors outline-none focus-visible:ring-1 motion-reduce:transition-none"
              >
                <span
                  aria-hidden
                  className="text-muted-foreground/60 group-hover:text-foreground font-mono text-xs"
                >
                  {">"}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  <SuggestionPrimitive.Title className="text-foreground" />{" "}
                  <SuggestionPrimitive.Description className="text-muted-foreground empty:hidden" />
                </span>
              </button>
            </SuggestionPrimitive.Trigger>
          </div>
        )}
      </ThreadPrimitive.Suggestions>
    </div>
  );
}

function ScrollToBottom() {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        variant="outline"
        className="absolute -top-12 z-10 size-9 self-center rounded-full p-4 disabled:invisible"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
}

function LoadingSkeleton() {
  return (
    <div role="status" className="animate-in fade-in flex flex-col gap-y-6 px-2 duration-200">
      <span className="sr-only">Loading the conversation…</span>
      <Skeleton className="ml-auto h-9 w-2/5 rounded-xl motion-reduce:animate-none" />
      <div className="flex flex-col gap-y-2">
        <Skeleton className="h-4 w-11/12 motion-reduce:animate-none" />
        <Skeleton className="h-4 w-4/5 motion-reduce:animate-none" />
        <Skeleton className="h-4 w-3/5 motion-reduce:animate-none" />
      </div>
    </div>
  );
}

/** The conversation on screen: the active branch of the entry tree, the run panel and composer. */
export function ThreadView() {
  const extras = useKobeExtras();
  const session = useChatSession();
  const agentName = useAgentName(extras?.state.summary?.agentId ?? null);
  const title = useAuiState((s) => s.threadListItem.title);
  const isEmpty = useAuiState((s) => s.thread.messages.length === 0);
  if (!extras) return null;
  const { state } = extras;
  const label = statusLabel(state);
  const welcome = state.phase === "ready" && isEmpty;

  return (
    <ThreadPrimitive.Root
      className="bg-background @container flex min-h-0 flex-1 flex-col"
      style={COMPOSER_VARS}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3 pb-2">
        <h2 id="kobe-thread-title" className="text-sm font-medium">
          {state.threadId === null
            ? "New conversation"
            : (state.summary?.title ?? title ?? "Untitled conversation")}
        </h2>
        {agentName && (
          <span className="text-muted-foreground rounded-full border px-2 text-xs">
            {`Agent: ${agentName}`}
          </span>
        )}
        {label && (
          <span className="text-muted-foreground rounded-full border px-2 text-xs">{label}</span>
        )}
      </header>
      {state.phase === "error" && state.loadError && (
        <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-2 px-4">
          <ErrorNotice error={state.loadError} />
          {extras.controller && (
            <button type="button" className="self-start" onClick={extras.controller.retryLoad}>
              Try again
            </button>
          )}
        </div>
      )}
      <ThreadPrimitive.Viewport
        turnAnchor="top"
        role="region"
        aria-labelledby="kobe-thread-title"
        className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth"
      >
        <div
          className={cn(
            "mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4",
            welcome && "justify-center",
          )}
        >
          {state.phase === "loading" && <LoadingSkeleton />}
          <ThreadPrimitive.Empty>
            {state.phase === "ready" && <ThreadWelcome />}
          </ThreadPrimitive.Empty>
          <div className="mb-14 flex flex-col gap-y-6 empty:hidden">
            <ThreadPrimitive.Messages>
              {({ message }) =>
                message.role === "user" ? (
                  message.composer.isEditing ? (
                    <EditComposer />
                  ) : (
                    <UserMessage />
                  )
                ) : (
                  <AssistantMessage />
                )
              }
            </ThreadPrimitive.Messages>
          </div>
          <ThreadPrimitive.ViewportFooter
            className={cn(
              "bg-background flex flex-col gap-3 overflow-visible pb-4 md:pb-6",
              !welcome && "sticky bottom-0 mt-auto rounded-t-2xl",
            )}
          >
            <ScrollToBottom />
            <RunPanel extras={extras} />
            {state.threadId === null && session.canChooseAgent && <AgentPicker />}
            <Composer extras={extras} />
            <AuiIf condition={(s) => s.thread.messages.length === 0 && s.composer.isEmpty}>
              {state.phase === "ready" && <ThreadSuggestions />}
            </AuiIf>
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
      <p role="status" aria-live="polite" className="sr-only">
        {state.announcement}
        {/* A changing no-break space makes a repeated message a change screen readers announce. */}
        {state.announcementSeq % 2 === 1 ? "\u00a0" : ""}
      </p>
    </ThreadPrimitive.Root>
  );
}
