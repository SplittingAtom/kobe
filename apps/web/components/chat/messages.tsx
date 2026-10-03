"use client";

import {
  ActionBarPrimitive,
  BranchPickerPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useAuiState,
  type DataMessagePartProps,
  type ReasoningMessagePartProps,
  type TextMessagePartProps,
} from "@assistant-ui/react";
import { ROOT_BRANCHING_AVAILABLE, ROOT_BRANCHING_PENDING } from "../../lib/chat/features";
import { messageMeta, type KobeMessageMeta } from "../../lib/chat/tree";
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
    <details className={styles.reasoning}>
      <summary>Reasoning</summary>
      {text}
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
function PendingAction({ label, id }: { readonly label: string; readonly id: string }) {
  return (
    <>
      <button
        type="button"
        aria-disabled="true"
        aria-describedby={id}
        title={ROOT_BRANCHING_PENDING}
        className={styles.pendingAction}
      >
        {label}
      </button>
      <span id={id} className={styles.visuallyHidden}>
        {ROOT_BRANCHING_PENDING}
      </span>
    </>
  );
}

function BranchPicker() {
  return (
    <BranchPickerPrimitive.Root hideWhenSingleBranch className={styles.messageFooter}>
      <BranchPickerPrimitive.Previous aria-label="Previous version">
        ‹
      </BranchPickerPrimitive.Previous>
      <span>
        Version <BranchPickerPrimitive.Number /> of <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next aria-label="Next version">›</BranchPickerPrimitive.Next>
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
      className={`${styles.message} ${styles.userMessage} ${pending ? styles.pending : ""}`}
    >
      <h3 className={styles.visuallyHidden}>You said</h3>
      <div className={styles.bubble}>
        <MessagePrimitive.Parts components={{ Text: PlainText }} />
      </div>
      <div className={styles.messageFooter}>
        {pending && <span>Sent, waiting for the agent</span>}
        {canEdit && (
          <ActionBarPrimitive.Root hideWhenRunning>
            <ActionBarPrimitive.Edit>Edit</ActionBarPrimitive.Edit>
          </ActionBarPrimitive.Root>
        )}
        {firstMessage && !ROOT_BRANCHING_AVAILABLE && (
          <PendingAction label="Edit" id={`kobe-edit-pending-${messageId}`} />
        )}
        <BranchPicker />
      </div>
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
    <MessagePrimitive.Root className={styles.message} aria-busy={running}>
      <h3 className={styles.visuallyHidden}>The agent said</h3>
      <div className={styles.assistantBody}>
        <MessagePrimitive.Parts components={ASSISTANT_PARTS} />
        {running && <span className={styles.who}>Working…</span>}
      </div>
      <div className={styles.messageFooter}>
        <ActionBarPrimitive.Root hideWhenRunning>
          <ActionBarPrimitive.Copy>Copy</ActionBarPrimitive.Copy>
          {regenerate === "yes" && (
            <ActionBarPrimitive.Reload>Regenerate</ActionBarPrimitive.Reload>
          )}
          {regenerate === "root" && !ROOT_BRANCHING_AVAILABLE && (
            <PendingAction label="Regenerate" id={`kobe-regenerate-pending-${messageId}`} />
          )}
        </ActionBarPrimitive.Root>
        <BranchPicker />
      </div>
    </MessagePrimitive.Root>
  );
}

/** Edit-and-regenerate: sending the edit branches from the edited message's parent entry. */
export function EditComposer() {
  return (
    <ComposerPrimitive.Root className={`${styles.message} ${styles.composer}`}>
      <label className={styles.visuallyHidden} htmlFor="kobe-edit-message">
        Edit your message
      </label>
      <ComposerPrimitive.Input id="kobe-edit-message" autoFocus />
      <div className={styles.composerActions}>
        <span className={styles.hint}>Sending starts a new version from here.</span>
        <ComposerPrimitive.Cancel>Cancel</ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send>Send</ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  );
}
