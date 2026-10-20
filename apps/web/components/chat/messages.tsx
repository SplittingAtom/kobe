"use client";

import { splitAppContext } from "../../lib/apps/app-context";
import { splitSkillRequest } from "@kobe/protocol";
import {
  ActionBarPrimitive,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  useAuiState,
  type DataMessagePartProps,
  type TextMessagePartProps,
} from "@assistant-ui/react";
import { CheckIcon, CopyIcon, WandSparklesIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import {
  branchPoint,
  branchPointOfMeta,
  type KobeMessageMeta,
  type SkippedReport,
} from "../../lib/chat/tree";
import { shortcutOf } from "../../lib/shell/shortcuts";
import { Button } from "../ui/button";
import { IconAction } from "../shell/icon-action";
import { AppCardPart } from "../apps/app-card";
import { useKobeExtras } from "./kobe-runtime";
import { isReadOnlyThread } from "./project-bar";
import { SentAttachments } from "./attachment-chips";
import { Markdown } from "./markdown";
import {
  AnswerFeedbackButtons,
  AnswerFeedbackDetails,
  AnswerFeedbackScope,
} from "./answer-feedback";
import { MessageFooter } from "./message-footer";
import { ForkAction } from "./fork-dialog";
import { RegenerateWith } from "./regenerate-with";
import { AnswerDetailScope, AnswerDetailToggle, Disclosure, useDisclosure } from "./detail";
import { CompactNowButton } from "./compact-now";
import { MarkerPart, MessageMarkers, withApprovalMarker } from "./markers";
import { UsedSkills } from "./skill-badge";
import { Reasoning } from "./reasoning";
import { FullOutputStatus, Output, useFullOutput } from "./tool-output";
import { ToolCallCard } from "./tool-call";
import { useArriving } from "./use-arriving";
import styles from "./chat.module.css";

/** A skill the member picked for this message (KOBE-451): the server's line, shown as a chip. */
function SentSkill({ name }: { readonly name: string }) {
  return (
    <p
      data-kobe-sent-skill={name}
      className="text-muted-foreground m-0 mb-1 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
    >
      <WandSparklesIcon aria-hidden className="size-3" />
      Skill: {name}
    </p>
  );
}

/** The user's message as typed (React escapes it). */
function PlainText({ text }: TextMessagePartProps) {
  // MCP Apps context sent with the message (KOBE-439): shown as chips, the JSON one click away.
  const { contexts, rest: afterContext } = splitAppContext(text);
  const { skill, rest } = splitSkillRequest(afterContext);
  if (contexts.length === 0 && skill === null) return <span>{text}</span>;
  return (
    <>
      {contexts.length > 0 && (
        <ul aria-label="App context sent" className="m-0 mb-1 flex list-none flex-col gap-1 p-0">
          {contexts.map((c, i) => (
            <li key={i} data-kobe-sent-app-context className="rounded-md border px-2 py-1 text-xs">
              <details>
                <summary className="cursor-pointer">
                  Context from {c.source} (untrusted data)
                </summary>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap">{c.json}</pre>
              </details>
            </li>
          ))}
        </ul>
      )}
      {skill !== null && <SentSkill name={skill} />}
      <span className={skill !== null ? "block" : undefined}>{rest}</span>
    </>
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

/**
 * An entry whose body is in object storage (D15): its role is unknown until read, so it shows as
 * its own block, read when opened (a tool output then shows; anything else says it can't).
 */
function Offloaded({ data }: DataMessagePartProps) {
  const { entryId } = data as { readonly entryId?: string };
  const { open, setOpen } = useDisclosure();
  const { output, retry } = useFullOutput(entryId, open);
  return (
    <Disclosure
      open={open}
      onOpenChange={setOpen}
      className="text-muted-foreground -ms-2 text-sm"
      bodyClassName="ps-2"
      summary={<span>A large part of this answer, stored separately</span>}
    >
      {output.status === "ready" ? (
        <Output text={output.text} error={output.isError} truncated={output.truncated} />
      ) : (
        <FullOutputStatus output={output} retry={retry} />
      )}
    </Disclosure>
  );
}

/**
 * Agent text: sanitised Markdown (`markdown.tsx`); the user's own text stays as typed. The part
 * being written fades its words in (KOBE-207); the status changes once per part, not per token.
 */
function MarkdownText({ text, status }: TextMessagePartProps) {
  return <Markdown text={text} words arriving={useArriving(status)} />;
}

const ASSISTANT_PARTS = {
  Text: MarkdownText,
  Reasoning,
  tools: { Override: withApprovalMarker(ToolCallCard) },
  data: {
    by_name: {
      "kobe-marker": MarkerPart,
      "kobe-problem": Problem,
      "kobe-offloaded": Offloaded,
      "kobe-skipped": SkippedActions,
      "kobe-app-card": AppCardPart,
    },
  },
} as const;

function useMeta(): KobeMessageMeta | undefined {
  return useAuiState((s) => s.message.metadata.custom as KobeMessageMeta | undefined);
}

export function UserMessage() {
  const meta = useMeta();
  const waiting = meta?.kind === "user" && meta.waiting === true;
  const extras = useKobeExtras();
  const readOnly = isReadOnlyThread(extras);
  const canEdit =
    !readOnly && extras !== undefined && branchPointOfMeta(extras.projection, meta) !== undefined;
  // The last message sent is the one Mod+Shift+E edits (CE23): its Edit tooltip names the key.
  const lastSent = useAuiState(
    (s) => s.thread.messages.findLast((m) => m.role === "user")?.id === s.message.id,
  );
  return (
    <MessagePrimitive.Root
      data-role="user"
      className={cn(
        "group/user animate-in fade-in slide-in-from-bottom-1 grid auto-rows-auto grid-cols-[minmax(72px,1fr)_fit-content(85%)] content-start gap-y-2 px-2 duration-150 [&:where(>*)]:col-start-2",
        waiting && "opacity-75",
      )}
    >
      <h3 className="sr-only">You said</h3>
      <MessageMarkers place="before" className="col-span-full col-start-1" />
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
            <ActionBarPrimitive.Root hideWhenRunning className="flex items-center">
              {canEdit && (
                <ActionBarPrimitive.Edit asChild>
                  <IconAction
                    command="edit"
                    size="sm"
                    shortcut={lastSent ? shortcutOf("edit-last-message") : undefined}
                  />
                </ActionBarPrimitive.Edit>
              )}
              <ForkAction meta={meta} />
            </ActionBarPrimitive.Root>
          </div>
        </div>
      </div>
      {meta?.kind === "user" &&
        meta.skipped?.map((report, i) => (
          <div key={i} className="col-span-full col-start-1 min-w-0">
            <SkippedReportCard text={report.text} count={report.count} />
          </div>
        ))}
      {waiting && (
        <span className="text-muted-foreground col-span-full col-start-1 justify-self-end text-xs">
          Sent, waiting for the agent
        </span>
      )}
      <MessageMarkers place="after" className="col-span-full col-start-1" />
    </MessagePrimitive.Root>
  );
}

/** Regenerate re-sends the question before this answer from that question's parent entry. */
function useCanRegenerate(): boolean {
  const parentId = useAuiState((s) => s.message.parentId);
  const extras = useKobeExtras();
  return extras !== undefined && branchPoint(extras.projection, parentId) !== undefined;
}

export function AssistantMessage() {
  const meta = useMeta();
  if (meta?.kind === "assistant" && meta.appCard === true) return <AppCardMessage />;
  return <AnswerMessage meta={meta} />;
}

/** A rail-launched app card (KOBE-440): the app in the conversation, no answer actions. */
function AppCardMessage() {
  return (
    <MessagePrimitive.Root
      data-role="assistant"
      className="animate-in fade-in slide-in-from-bottom-1 relative duration-150"
    >
      <h3 className="sr-only">An app you opened</h3>
      <MessageMarkers place="before" className="mb-2" />
      <div className="flex flex-col gap-2 px-2">
        <MessagePrimitive.Parts components={ASSISTANT_PARTS} />
      </div>
      <MessageMarkers place="after" className="mt-2" />
    </MessagePrimitive.Root>
  );
}

function AnswerMessage({ meta }: { readonly meta: KobeMessageMeta | undefined }) {
  const running = useAuiState((s) => s.message.status?.type === "running");
  const readOnly = isReadOnlyThread(useKobeExtras());
  const canRegenerate = useCanRegenerate();
  return (
    <MessagePrimitive.Root
      data-role="assistant"
      aria-busy={running}
      className="group/answer animate-in fade-in slide-in-from-bottom-1 relative duration-150"
    >
      <AnswerFeedbackScope>
        <AnswerDetailScope>
          <h3 className="sr-only">The agent said</h3>
          <MessageMarkers place="before" className="mb-2" />
          <div className="text-foreground flex flex-col gap-2 px-2 leading-relaxed wrap-break-word">
            <MessagePrimitive.Parts components={ASSISTANT_PARTS} />
            <UsedSkills />
            {running && (
              <span className="text-muted-foreground animate-pulse text-sm motion-reduce:animate-none">
                Working…
              </span>
            )}
          </div>
          <div className="ms-2 flex min-h-7.5 items-center gap-2 pe-2 pt-1.5">
            <ActionBarPrimitive.Root
              hideWhenRunning
              data-kobe-answer-actions
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
              {!readOnly && canRegenerate && (
                <>
                  <ActionBarPrimitive.Reload asChild>
                    <IconAction command="regenerate" size="sm" />
                  </ActionBarPrimitive.Reload>
                  <RegenerateWith />
                </>
              )}
              <ForkAction meta={meta} />
              <AnswerDetailToggle />
              <AnswerFeedbackButtons />
              <CompactNowButton />
            </ActionBarPrimitive.Root>
            {!running && <MessageFooter />}
          </div>
          {!running && <AnswerFeedbackDetails />}
          <MessageMarkers place="after" className="mt-2" />
        </AnswerDetailScope>
      </AnswerFeedbackScope>
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
