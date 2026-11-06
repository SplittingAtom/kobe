"use client";

import { fromThreadMessageLike, MessageProvider, type ThreadMessage } from "@assistant-ui/react";
import { Dialog } from "radix-ui";
import { XIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  COMPARE_TITLE,
  COMPARING,
  NO_COMPARE,
  choicesFor,
  initialPair,
  pickVersion,
  promptsDiffer,
  versionTitle,
  versionsOf,
  type CompareVersion,
} from "../../lib/chat/compare";
import type { Projection } from "../../lib/chat/tree";
import { cn } from "../../lib/utils";
import { useShellBand } from "../shell/shell-band";
import { Button } from "../ui/button";
import { chatPortalContainer } from "../ui/chat-portal";
import type { KobeThreadExtras } from "./kobe-runtime";
import { MessageFooter } from "./message-footer";
import { ReadOnlyAnswer, ReadOnlyPrompt } from "./messages";
import styles from "./compare-dialog.module.css";

const COMPLETE = { type: "complete", reason: "unknown" } as const;
const SIDES = ["left", "right"] as const;
type Side = 0 | 1;

/** A projected message as assistant-ui's, for a message context of its own (off screen too). */
function useThreadMessage(projection: Projection, id: string | undefined): ThreadMessage | null {
  return useMemo(() => {
    const item = id === undefined ? undefined : projection.items.find((i) => i.message.id === id);
    return item ? fromThreadMessageLike(item.message, item.message.id, COMPLETE) : null;
  }, [projection, id]);
}

/**
 * The two versions shown. Each column keeps the version it was given (a snapshot): one that drops
 * out of the projection mid-view (another page of entries, a reset) shows as having no answer
 * until the dropdown picks another, so the dialog never closes on its own.
 */
function usePair(versions: readonly CompareVersion[], picked: string | undefined) {
  const [pair, setPair] = useState<readonly [CompareVersion, CompareVersion] | undefined>(() => {
    const ids = initialPair(versions, picked);
    const of = (id: string) => versions.find((v) => v.id === id);
    const a = ids && of(ids[0]);
    const b = ids && of(ids[1]);
    return a && b ? [a, b] : undefined;
  });
  const current = (v: CompareVersion): CompareVersion =>
    versions.find((x) => x.id === v.id) ?? { id: v.id, k: v.k, role: v.role };
  const shown = pair && ([current(pair[0]), current(pair[1])] as const);
  const pick = (side: Side, id: string) => {
    if (!pair) return;
    const ids = pickVersion([pair[0].id, pair[1].id], side, id);
    const next = (i: Side) => versions.find((v) => v.id === ids[i]) ?? (pair[i] as CompareVersion);
    setPair([next(0), next(1)]);
  };
  return { shown, pick };
}

/**
 * Compare versions (CT10, KOBE-547): two versions of a message side by side, each rendered
 * read-only as the conversation renders it, in the chat's portal; full-screen under 820 px.
 * View-only: the only writes are the answers' feedback and Show this version, which moves this
 * tab's head (CT3), never the leaf, and closes.
 */
export function CompareDialog({
  extras,
  messageId,
  picked = false,
  labelOf,
  onClose,
}: {
  readonly extras: KobeThreadExtras;
  readonly messageId: string;
  /** Start from this message (left column) rather than the two newest. */
  readonly picked?: boolean | undefined;
  readonly labelOf: (messageId: string) => string | undefined;
  readonly onClose: () => void;
}) {
  const { controller, projection } = extras;
  const versions = useMemo(() => versionsOf(projection, messageId), [projection, messageId]);
  const { shown, pick } = usePair(versions, picked ? messageId : undefined);
  useEffect(() => {
    controller?.announce(COMPARING);
  }, [controller]);
  const show = (version: CompareVersion) => {
    if (version.headEntry !== undefined)
      controller?.showBranch(version.headEntry, version.revealEntry);
    onClose();
  };
  const titleOf = (v: CompareVersion) =>
    versionTitle(v, labelOf(v.id) ?? labelOf(v.answerId ?? ""));
  return (
    <CompareFrame
      onClose={onClose}
      description={
        shown === undefined
          ? NO_COMPARE
          : `${versions.length} versions of this ${shown[0].role === "user" ? "message" : "answer"}. Nothing changes until you choose Show this version.`
      }
    >
      {shown !== undefined && (
        <div className={styles.columns}>
          {shown.map((version, i) => {
            const side: Side = i === 0 ? 0 : 1;
            const other = shown[1 - side] as CompareVersion;
            return (
              <VersionColumn
                key={SIDES[side]}
                side={side}
                version={version}
                title={titleOf(version)}
                choices={
                  versions.length > 2
                    ? choicesFor(versions, other.id).map((v) => ({ id: v.id, title: titleOf(v) }))
                    : []
                }
                projection={projection}
                withPrompt={promptsDiffer(projection, shown[0], shown[1])}
                onPick={(id) => pick(side, id)}
                onShow={() => show(version)}
              />
            );
          })}
        </div>
      )}
    </CompareFrame>
  );
}

/** The dialog itself: title, description, Close; a sheet under 820 px. */
function CompareFrame({
  description,
  onClose,
  children,
}: {
  readonly description: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const band = useShellBand();
  const sheet = band === "overlay" || band === "single";
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal container={chatPortalContainer()}>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" data-kobe-portal />
        <Dialog.Content
          className={cn(styles.dialog, "shadow-lg", sheet && styles.sheet)}
          data-kobe-portal
          data-kobe-compare={sheet ? "sheet" : "dialog"}
        >
          <div className={styles.top}>
            <div className={styles.heading}>
              <Dialog.Title className={styles.title}>{COMPARE_TITLE}</Dialog.Title>
              <Dialog.Description className={styles.description}>{description}</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" size="icon" aria-label="Close">
                <XIcon aria-hidden />
              </Button>
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function VersionColumn({
  side,
  version,
  title,
  choices,
  projection,
  withPrompt,
  onPick,
  onShow,
}: {
  readonly side: Side;
  readonly version: CompareVersion;
  /** "Version k" and its label ("Version 3 · cheaper"). */
  readonly title: string;
  /** The dropdown's versions (more than two in all), else none. */
  readonly choices: readonly { readonly id: string; readonly title: string }[];
  readonly projection: Projection;
  readonly withPrompt: boolean;
  readonly onPick: (id: string) => void;
  readonly onShow: () => void;
}) {
  const answer = useThreadMessage(projection, version.answerId);
  const prompt = useThreadMessage(projection, withPrompt ? version.promptId : undefined);
  const head = (
    <div className={styles.columnHead}>
      <h3 className={styles.columnTitle}>{title}</h3>
      {choices.length > 0 && (
        <select
          aria-label={`Version in the ${SIDES[side]} column`}
          className={styles.pick}
          value={version.id}
          onChange={(e) => onPick(e.target.value)}
        >
          {choices.map((v) => (
            <option key={v.id} value={v.id}>
              {v.title}
            </option>
          ))}
        </select>
      )}
      {answer !== null && <MessageFooter shown />}
    </div>
  );
  const promptView = prompt !== null && (
    <MessageProvider message={prompt} index={0}>
      <ReadOnlyPrompt />
    </MessageProvider>
  );
  return (
    <section
      role="region"
      aria-label={title}
      className={styles.column}
      data-kobe-compare-column={SIDES[side]}
    >
      {answer === null ? (
        <>
          {head}
          {promptView}
          <p className={styles.empty}>No answer on this version.</p>
        </>
      ) : (
        // One message context per column: the heading's usage and the answer read the same one.
        <MessageProvider message={answer} index={0}>
          {head}
          {promptView}
          <ReadOnlyAnswer />
        </MessageProvider>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={styles.show}
        disabled={version.headEntry === undefined}
        onClick={onShow}
      >
        Show this version
      </Button>
    </section>
  );
}
