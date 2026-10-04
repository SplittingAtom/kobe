"use client";

import {
  ActionBarPrimitive,
  AuiIf,
  BranchPickerPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useAuiState,
  type DataMessagePartProps,
  type ReasoningMessagePartProps,
  type TextMessagePartProps,
} from "@assistant-ui/react";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  PencilIcon,
  RefreshCwIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import { cn } from "../../lib/utils";
import { ROOT_BRANCHING_AVAILABLE, ROOT_BRANCHING_PENDING } from "../../lib/chat/features";
import { messageMeta, type KobeMessageMeta } from "../../lib/chat/tree";
import { Button } from "../ui/button";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button";
import { useKobeExtras } from "./kobe-runtime";
import { Markdown } from "./markdown";
import { ToolCallCard } from "./tool-call";
import styles from "./chat.module.css";

/** The user's message as typed (React escapes it). */
function PlainText({ text }: TextMessagePartProps) {
  return <span>{text}</span>;
}

function Reasoning({ text }: ReasoningMessagePartProps) {
  return (
    <details className="text-muted-foreground group my-2 text-sm">
      <summary className="hover:text-foreground cursor-pointer select-none">Reasoning</summary>
      <p className="border-border mt-1 border-s-2 ps-3 whitespace-pre-wrap">{text}</p>
    </details>
  );
}

function Problem({ data }: DataMessagePartProps) {
  const problem = data as { readonly reason?: string; readonly message?: string };
  return (
    <p className={problem.reason === "aborted" ? styles.notice : styles.denied} role="note">
      {problem.message}
    </p>
  );
}

function Offloaded() {
  return <p className={styles.notice}>This part of the conversation is too large to show here.</p>;
}

/** Agent text: sanitised Markdown (`markdown.tsx`); the user's own text stays as typed. */
function MarkdownText({ text }: TextMessagePartProps) {
  return <Markdown text={text} />;
}

const ASSISTANT_PARTS = {
  Text: MarkdownText,
  Reasoning,
  tools: { Override: ToolCallCard },
  data: { by_name: { "kobe-problem": Problem, "kobe-offloaded": Offloaded } },
} as const;

function useMeta(): KobeMessageMeta | undefined {
  return useAuiState((s) => s.message.metadata.custom as KobeMessageMeta | undefined);
}

/**
 * An action the first exchange can't take yet (root branching, `lib/chat/features.ts`): focusable,
 * announced as unavailable, with the reason as its description and tooltip.
 */
function PendingAction({
  label,
  id,
  icon: Icon,
}: {
  readonly label: string;
  readonly id: string;
  readonly icon: ComponentType;
}) {
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-disabled="true"
        aria-describedby={id}
        title={ROOT_BRANCHING_PENDING}
        className="size-6 cursor-not-allowed p-1 opacity-50 hover:bg-transparent"
      >
        <Icon />
        <span className="sr-only">{label}</span>
      </Button>
      <span id={id} className="sr-only">
        {ROOT_BRANCHING_PENDING}
      </span>
    </>
  );
}

function BranchPicker({ className }: { readonly className?: string }) {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn("text-muted-foreground -ms-2 me-2 inline-flex items-center text-xs", className)}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip="Previous version">
          <ChevronLeftIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="font-medium">
        Version <BranchPickerPrimitive.Number /> of <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip="Next version">
          <ChevronRightIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
}

export function UserMessage() {
  const meta = useMeta();
  const pending = meta?.kind === "user" && meta.pending;
  const canEdit = meta?.kind === "user" && !meta.pending && meta.parentEntryId !== null;
  const firstMessage = meta?.kind === "user" && !meta.pending && meta.parentEntryId === null;
  const messageId = useAuiState((s) => s.message.id);
  return (
    <MessagePrimitive.Root
      data-role="user"
      className={cn(
        "group/user animate-in fade-in slide-in-from-bottom-1 grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [&:where(>*)]:col-start-2",
        pending && "opacity-75",
      )}
    >
      <h3 className="sr-only">You said</h3>
      <div className="relative col-start-2 min-w-0">
        <div className="peer bg-muted text-foreground rounded-2xl px-4 py-2 wrap-break-word whitespace-pre-wrap empty:hidden">
          <MessagePrimitive.Parts components={{ Text: PlainText }} />
        </div>
        <div className="absolute start-0 top-1/2 -translate-x-full -translate-y-1/2 pe-2 peer-empty:hidden rtl:translate-x-full">
          <div className="text-muted-foreground flex items-center [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within/user:opacity-100 [@media(hover:hover)]:group-hover/user:opacity-100">
            {canEdit && (
              <ActionBarPrimitive.Root hideWhenRunning>
                <ActionBarPrimitive.Edit asChild>
                  <TooltipIconButton tooltip="Edit">
                    <PencilIcon />
                  </TooltipIconButton>
                </ActionBarPrimitive.Edit>
              </ActionBarPrimitive.Root>
            )}
            {firstMessage && !ROOT_BRANCHING_AVAILABLE && (
              <PendingAction label="Edit" id={`kobe-edit-pending-${messageId}`} icon={PencilIcon} />
            )}
          </div>
        </div>
      </div>
      {pending && (
        <span className="text-muted-foreground col-span-full col-start-1 justify-self-end text-xs">
          Sent, waiting for the agent
        </span>
      )}
      <BranchPicker className="col-span-full col-start-1 -me-1 justify-end" />
    </MessagePrimitive.Root>
  );
}

/** Regenerate re-sends the question before this answer from that question's parent entry. */
function useRegenerate(): "yes" | "root" | "no" {
  const parentId = useAuiState((s) => s.message.parentId);
  const extras = useKobeExtras();
  const parent = extras?.projection.items.find((i) => i.message.id === parentId);
  const meta = parent ? messageMeta(parent.message) : undefined;
  if (meta?.kind !== "user" || meta.pending) return "no";
  return meta.parentEntryId !== null ? "yes" : "root";
}

export function AssistantMessage() {
  const running = useAuiState((s) => s.message.status?.type === "running");
  const regenerate = useRegenerate();
  const messageId = useAuiState((s) => s.message.id);
  return (
    <MessagePrimitive.Root
      data-role="assistant"
      aria-busy={running}
      className="animate-in fade-in slide-in-from-bottom-1 relative duration-150"
    >
      <h3 className="sr-only">The agent said</h3>
      <div className="text-foreground flex flex-col gap-2 px-2 leading-relaxed wrap-break-word">
        <MessagePrimitive.Parts components={ASSISTANT_PARTS} />
        {running && (
          <span className="text-muted-foreground animate-pulse text-sm motion-reduce:animate-none">
            Working…
          </span>
        )}
      </div>
      <div className="ms-2 flex min-h-7.5 items-center pt-1.5">
        <BranchPicker />
        <ActionBarPrimitive.Root
          hideWhenRunning
          className="text-muted-foreground animate-in fade-in -ms-1 flex gap-1 duration-200"
        >
          <ActionBarPrimitive.Copy asChild>
            <TooltipIconButton tooltip="Copy">
              <AuiIf condition={(s) => s.message.isCopied}>
                <CheckIcon />
              </AuiIf>
              <AuiIf condition={(s) => !s.message.isCopied}>
                <CopyIcon />
              </AuiIf>
            </TooltipIconButton>
          </ActionBarPrimitive.Copy>
          {regenerate === "yes" && (
            <ActionBarPrimitive.Reload asChild>
              <TooltipIconButton tooltip="Regenerate">
                <RefreshCwIcon />
              </TooltipIconButton>
            </ActionBarPrimitive.Reload>
          )}
          {regenerate === "root" && !ROOT_BRANCHING_AVAILABLE && (
            <PendingAction
              label="Regenerate"
              id={`kobe-regenerate-pending-${messageId}`}
              icon={RefreshCwIcon}
            />
          )}
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
}

/** Edit-and-regenerate: sending the edit branches from the edited message's parent entry. */
export function EditComposer() {
  return (
    <div className="flex flex-col px-2">
      <ComposerPrimitive.Root className="border-foreground/10 focus-within:border-foreground/25 bg-muted/30 ms-auto flex w-full max-w-[85%] cursor-text flex-col rounded-2xl border transition-[border-color]">
        <label className="sr-only" htmlFor="kobe-edit-message">
          Edit your message
        </label>
        <ComposerPrimitive.Input
          id="kobe-edit-message"
          autoFocus
          className="text-foreground min-h-14 w-full resize-none border-0 bg-transparent px-4 pt-3 pb-1 text-base outline-none focus-visible:shadow-none"
        />
        <div className="mx-2.5 mb-2.5 flex flex-wrap items-center gap-1.5 self-end">
          <span className="text-muted-foreground me-auto text-xs">
            Sending starts a new version from here.
          </span>
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm" className="h-8 px-3">
              Cancel
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm" className="h-8 px-3">
              Send
            </Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </div>
  );
}
