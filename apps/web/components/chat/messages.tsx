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
import { CheckIcon, CopyIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { ROOT_BRANCHING_AVAILABLE, ROOT_BRANCHING_PENDING } from "../../lib/chat/features";
import { messageMeta, type KobeMessageMeta, type SkippedReport } from "../../lib/chat/tree";
import { Button } from "../ui/button";
import { IconAction } from "../shell/icon-action";
import { useKobeExtras } from "./kobe-runtime";
import { isReadOnlyThread } from "./project-bar";
import { SentAttachments } from "./attachment-chips";
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
    <p className={problem.reason === "error" ? styles.denied : styles.notice} role="note">
      {problem.message}
    </p>
  );
}

/**
 * A scheduled run's skipped-actions summary (KOBE-178): the server's template text, one line per
 * skipped call ("- tool (risk): reason"), shown as plain text. Empty text: the body is offloaded.
 */
function SkippedReportCard({ text, count }: SkippedReport) {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const calls = lines.filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
  const intro = lines.filter((l) => !l.startsWith("- ") && l !== "Skipped actions");
  return (
    <section className={styles.skipped} aria-label="Skipped actions">
      <p className={styles.skippedTitle}>Skipped actions{count > 0 ? ` (${count})` : ""}</p>
      {lines.length === 0 && (
        <p className={styles.hint}>This scheduled run&apos;s report is too large to show here.</p>
      )}
      {intro.map((line, i) => (
        <p key={i} className={styles.hint}>
          {line}
        </p>
      ))}
      {calls.length > 0 && (
        <ul className={styles.skippedList}>
          {calls.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SkippedActions({ data }: DataMessagePartProps) {
  const { text = "", count = 0 } = data as Partial<SkippedReport>;
  return <SkippedReportCard text={text} count={count} />;
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
  data: {
    by_name: {
      "kobe-problem": Problem,
      "kobe-offloaded": Offloaded,
      "kobe-skipped": SkippedActions,
    },
  },
} as const;

function useMeta(): KobeMessageMeta | undefined {
  return useAuiState((s) => s.message.metadata.custom as KobeMessageMeta | undefined);
}

/**
 * An action the first exchange can't take yet (root branching, `lib/chat/features.ts`): focusable,
 * announced as unavailable, with the reason as its description and tooltip.
 */
function PendingAction({ command }: { readonly command: "edit" | "regenerate" }) {
  return (
    <IconAction
      command={command}
      size="sm"
      aria-disabled="true"
      description={ROOT_BRANCHING_PENDING}
      className="hover:bg-transparent"
    />
  );
}

function BranchPicker({ className }: { readonly className?: string }) {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn("text-muted-foreground -ms-2 me-2 inline-flex items-center text-xs", className)}
    >
      <BranchPickerPrimitive.Previous asChild>
        <IconAction command="previous-branch" size="sm" />
      </BranchPickerPrimitive.Previous>
      <span className="font-medium">
        Version <BranchPickerPrimitive.Number /> of <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <IconAction command="next-branch" size="sm" />
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
}

export function UserMessage() {
  const meta = useMeta();
  const pending = meta?.kind === "user" && meta.pending;
  const readOnly = isReadOnlyThread(useKobeExtras());
  const canEdit =
    !readOnly && meta?.kind === "user" && !meta.pending && meta.parentEntryId !== null;
  const firstMessage =
    !readOnly && meta?.kind === "user" && !meta.pending && meta.parentEntryId === null;
  return (
    <MessagePrimitive.Root
      data-role="user"
      className={cn(
        "group/user animate-in fade-in slide-in-from-bottom-1 grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [&:where(>*)]:col-start-2",
        pending && "opacity-75",
      )}
    >
      <h3 className="sr-only">You said</h3>
      {meta?.kind === "user" && meta.attachments && meta.attachments.length > 0 && (
        <div className="col-start-2 min-w-0">
          <SentAttachments files={meta.attachments} />
        </div>
      )}
      <div className="relative col-start-2 min-w-0">
        <div className="peer bg-muted text-foreground rounded-2xl px-4 py-2 wrap-break-word whitespace-pre-wrap empty:hidden">
          <MessagePrimitive.Parts components={{ Text: PlainText }} />
        </div>
        <div className="absolute start-0 top-1/2 -translate-x-full -translate-y-1/2 pe-2 peer-empty:hidden rtl:translate-x-full">
          <div className="text-muted-foreground flex items-center [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within/user:opacity-100 [@media(hover:hover)]:group-hover/user:opacity-100">
            {canEdit && (
              <ActionBarPrimitive.Root hideWhenRunning>
                <ActionBarPrimitive.Edit asChild>
                  <IconAction command="edit" size="sm" />
                </ActionBarPrimitive.Edit>
              </ActionBarPrimitive.Root>
            )}
            {firstMessage && !ROOT_BRANCHING_AVAILABLE && <PendingAction command="edit" />}
          </div>
        </div>
      </div>
      {meta?.kind === "user" &&
        meta.skipped?.map((report, i) => (
          <div key={i} className="col-span-full col-start-1 min-w-0">
            <SkippedReportCard text={report.text} count={report.count} />
          </div>
        ))}
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
  const readOnly = isReadOnlyThread(useKobeExtras());
  const regenerate = useRegenerate();
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
            <IconAction command="copy" size="sm">
              <AuiIf condition={(s) => s.message.isCopied}>
                <CheckIcon aria-hidden />
              </AuiIf>
              <AuiIf condition={(s) => !s.message.isCopied}>
                <CopyIcon aria-hidden />
              </AuiIf>
            </IconAction>
          </ActionBarPrimitive.Copy>
          {!readOnly && regenerate === "yes" && (
            <ActionBarPrimitive.Reload asChild>
              <IconAction command="regenerate" size="sm" />
            </ActionBarPrimitive.Reload>
          )}
          {!readOnly && regenerate === "root" && !ROOT_BRANCHING_AVAILABLE && (
            <PendingAction command="regenerate" />
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
