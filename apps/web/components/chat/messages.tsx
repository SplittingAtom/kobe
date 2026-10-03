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
import type { KobeMessageMeta } from "../../lib/chat/tree";
import { ToolCallCard } from "./tool-call";
import styles from "./chat.module.css";

/** Agent text is shown as plain text (React escapes it); Markdown rendering is a follow-up. */
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

const ASSISTANT_PARTS = {
  Text: PlainText,
  Reasoning,
  tools: { Override: ToolCallCard },
  data: { by_name: { "kobe-problem": Problem, "kobe-offloaded": Offloaded } },
} as const;

function useMeta(): KobeMessageMeta | undefined {
  return useAuiState((s) => s.message.metadata.custom as KobeMessageMeta | undefined);
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
        <BranchPicker />
      </div>
    </MessagePrimitive.Root>
  );
}

export function AssistantMessage() {
  const running = useAuiState((s) => s.message.status?.type === "running");
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
          <ActionBarPrimitive.Reload>Regenerate</ActionBarPrimitive.Reload>
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
