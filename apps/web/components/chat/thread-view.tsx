"use client";

import { AuiIf, SuggestionPrimitive, ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import { useState } from "react";
import { newSince, shownCount } from "../../lib/chat/scroll-follow";
import { cn } from "../../lib/utils";
import { IconAction } from "../shell/icon-action";
import { Skeleton } from "../ui/skeleton";
import { isThreadRunning, type ThreadState } from "../../lib/chat/thread-state";
import { ErrorNotice } from "../admin/error-notice";
import { FilesButton } from "../shell/rail-state";
import { ArtifactList } from "./artifact-list";
import { AgentChips } from "./agent-chips";
import { Composer } from "./composer";
import { ComposerDictationProvider } from "./composer-steer";
import { DraftProjectNote, ProjectBar } from "./project-bar";
import { OpenThreadContext } from "./fork-dialog";
import { ForkOriginNote } from "./fork-origin";
import { useKobeExtras, type KobeThreadExtras } from "./kobe-runtime";
import { AssistantMessage, EditComposer, UserMessage } from "./messages";
import { RunNotices } from "./run-notices";
import { SteeringPanel } from "./steering-panel";
import { ThreadCommands } from "./thread-commands";
import { AgentStarters, FollowupChips, useAgentStarters } from "./suggestion-chips";
import { ThreadTitle } from "./thread-title";
import { useFollowLatest } from "./use-follow";

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

/**
 * The floating Jump to latest pill (CE9): mounted while the member is scrolled up, once per thread
 * (keyed), so the count starts from what was on screen then. assistant-ui's ScrollToBottom scrolls
 * and re-pins.
 */
function JumpToLatest() {
  const count = useAuiState((s) => shownCount(s.thread.messages));
  const [atUnpin] = useState(count);
  const fresh = newSince(atUnpin, count);
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
      <ThreadPrimitive.ScrollToBottom asChild>
        <IconAction
          command="jump-to-latest"
          variant="outline"
          side="top"
          badge={fresh > 0 ? `${fresh} new ${fresh === 1 ? "message" : "messages"}` : undefined}
          count={fresh > 0 ? fresh : undefined}
          className="bg-background pointer-events-auto size-9 rounded-full shadow-md"
        />
      </ThreadPrimitive.ScrollToBottom>
    </div>
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

/**
 * The message list over the composer (CE9, KOBE-205). Once a thread has messages the list is its
 * own scroll container and the composer a fixed footer below it, outside the scroll; an empty
 * thread centres the welcome and the composer instead. Scroll anchoring (`overflow-anchor`) keeps
 * what is on screen still while content above it grows, such as a tool card. `turnAnchor` stays
 * assistant-ui's default (bottom) on purpose: Chris asked for the chat to follow the stream, and
 * `top` does not follow during a run. assistant-ui follows only while `useFollowLatest` is pinned.
 */
function MessagesAndComposer({
  extras,
  welcome,
  modelPicker,
}: {
  readonly extras: KobeThreadExtras;
  readonly welcome: boolean;
  readonly modelPicker: boolean;
}) {
  const { state } = extras;
  const starters = useAgentStarters(extras);
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const hasMessages = useAuiState((s) => s.thread.messages.length > 0);
  const follow = useFollowLatest(
    viewport,
    state.threadId,
    state.phase === "ready" && hasMessages,
    state.actionError,
  );
  return (
    <>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ThreadPrimitive.Viewport
          ref={setViewport}
          autoScroll={follow === "pinned"}
          scrollToBottomOnRunStart={false}
          scrollToBottomOnInitialize={false}
          scrollToBottomOnThreadSwitch={false}
          role="region"
          aria-labelledby="kobe-thread-title"
          data-kobe-scroll="messages"
          data-kobe-follow={follow}
          className="flex min-h-0 flex-1 flex-col overflow-x-auto overflow-y-auto overscroll-contain scroll-smooth [overflow-anchor:auto] motion-reduce:scroll-auto"
        >
          <div
            className={cn(
              "mx-auto flex w-full max-w-(--thread-max-width) flex-col px-4 pt-4 pb-14",
              welcome ? "mt-auto pb-6" : "flex-1",
            )}
          >
            {state.phase === "loading" && <LoadingSkeleton />}
            <ThreadPrimitive.Empty>
              {state.phase === "ready" && <ThreadWelcome />}
            </ThreadPrimitive.Empty>
            <div className="flex flex-col gap-y-6 empty:hidden">
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
          </div>
        </ThreadPrimitive.Viewport>
        {follow === "unpinned" && hasMessages && <JumpToLatest key={state.threadId ?? ""} />}
      </div>
      <div data-kobe-composer className={cn("bg-background shrink-0", welcome && "flex-1")}>
        <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-3 px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] md:pb-6">
          {/* Long notices scroll on their own, so they never push the composer away. */}
          <div className="max-h-[30dvh] overflow-y-auto overscroll-contain empty:hidden">
            <RunNotices extras={extras} />
          </div>
          <FollowupChips extras={extras} />
          <ComposerDictationProvider>
            {/* The overlay sheet at 768–820 px ends above this box (KOBE-269, chat-global.css). */}
            <div className="flex flex-col" data-kobe-composer-box>
              <SteeringPanel extras={extras} />
              <Composer extras={extras} modelPicker={modelPicker} />
            </div>
          </ComposerDictationProvider>
          <AuiIf condition={(s) => s.thread.messages.length === 0 && s.composer.isEmpty}>
            {state.phase === "ready" &&
              state.summary?.readOnly !== true &&
              (starters.length > 0 ? <AgentStarters starters={starters} /> : <ThreadSuggestions />)}
          </AuiIf>
        </div>
      </div>
    </>
  );
}

/**
 * The conversation on screen: the active branch of the entry tree, the run notices, the steering
 * panel (CE10) and the composer.
 * It fills its column and never grows past it: only the message list scrolls (KOBE-205).
 * In the chat shell (`contextInBar`) the agent, model and Files controls live in bar row two
 * (KOBE-197); the builder's test pane keeps them here.
 */
export function ThreadView({
  onOpenThread,
  contextInBar = false,
}: {
  readonly onOpenThread?: ((threadId: string) => void) | undefined;
  readonly contextInBar?: boolean;
} = {}) {
  const extras = useKobeExtras();
  const isEmpty = useAuiState((s) => s.thread.messages.length === 0);
  if (!extras) return null;
  const { state } = extras;
  const label = statusLabel(state);
  const welcome = state.phase === "ready" && isEmpty;

  return (
    <ThreadPrimitive.Root
      className="bg-background @container flex min-h-0 flex-1 flex-col overflow-hidden"
      style={COMPOSER_VARS}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3 pb-2">
        <ThreadTitle state={state} controller={extras.controller} editable={contextInBar} />
        {!contextInBar && <AgentChips />}
        {label && (
          <span className="text-muted-foreground rounded-full border px-2 text-xs">{label}</span>
        )}
        {!contextInBar && (
          <span className="ms-auto">
            <FilesButton />
          </span>
        )}
      </header>
      <div className="mx-auto w-full max-w-(--thread-max-width) px-4">
        <ProjectBar extras={extras} onOpenThread={onOpenThread} />
        {state.threadId === null && <DraftProjectNote />}
        <ForkOriginNote extras={extras} onOpenThread={onOpenThread} />
      </div>
      <ArtifactList />
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
      <OpenThreadContext.Provider value={onOpenThread}>
        <ThreadCommands extras={extras} />
        <ThreadPrimitive.ViewportProvider>
          <MessagesAndComposer extras={extras} welcome={welcome} modelPicker={!contextInBar} />
        </ThreadPrimitive.ViewportProvider>
      </OpenThreadContext.Provider>
      <p role="status" aria-live="polite" className="sr-only">
        {state.announcement}
        {/* A changing no-break space makes a repeated message a change screen readers announce. */}
        {state.announcementSeq % 2 === 1 ? "\u00a0" : ""}
      </p>
    </ThreadPrimitive.Root>
  );
}
