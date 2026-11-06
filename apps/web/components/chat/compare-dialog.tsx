"use client";

import { fromThreadMessageLike, MessageProvider, type ThreadMessage } from "@assistant-ui/react";
import { Dialog } from "radix-ui";
import { XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  COMPARE_TITLE,
  COMPARING,
  choicesFor,
  initialPair,
  pickVersion,
  promptsDiffer,
  versionTitle,
  versionsOf,
  type CompareVersion,
  type ComparePair,
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

/** A projected message as assistant-ui's, for a message context of its own (off screen too). */
function useThreadMessage(projection: Projection, id: string | undefined): ThreadMessage | null {
  return useMemo(() => {
    const item = id === undefined ? undefined : projection.items.find((i) => i.message.id === id);
    return item ? fromThreadMessageLike(item.message, item.message.id, COMPLETE) : null;
  }, [projection, id]);
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
  labelOf,
  onClose,
}: {
  readonly extras: KobeThreadExtras;
  readonly messageId: string;
  readonly labelOf: (messageId: string) => string | undefined;
  readonly onClose: () => void;
}) {
  const { controller, projection } = extras;
  const versions = useMemo(() => versionsOf(projection, messageId), [projection, messageId]);
  const [pair, setPair] = useState<ComparePair | undefined>(() => initialPair(versions));
  const band = useShellBand();
  const sheet = band === "overlay" || band === "single";
  useEffect(() => {
    controller?.announce(COMPARING);
  }, [controller]);
  // A version gone from the projection (another page of entries, a reset) starts over.
  const shown = pair?.map((id) => versions.find((v) => v.id === id));
  const [left, right] = shown ?? [];
  useEffect(() => {
    if (left !== undefined && right !== undefined) return;
    const next = initialPair(versions);
    if (next === undefined) onClose();
    else setPair(next);
  }, [left, right, versions, onClose]);
  if (left === undefined || right === undefined || pair === undefined) return null;
  const withPrompts = promptsDiffer(projection, left, right);
  const show = (version: CompareVersion) => {
    if (version.headEntry !== undefined)
      controller?.showBranch(version.headEntry, version.revealEntry);
    onClose();
  };
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
              <Dialog.Description className={styles.description}>
                {versions.length} versions of this {left.role === "user" ? "message" : "answer"}.
                Nothing changes until you choose Show this version.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" size="icon" aria-label="Close">
                <XIcon aria-hidden />
              </Button>
            </Dialog.Close>
          </div>
          <div className={styles.columns}>
            {[left, right].map((version, i) => {
              const side = i === 0 ? 0 : 1;
              return (
                <VersionColumn
                  key={SIDES[side]}
                  side={side}
                  version={version}
                  choices={versions.length > 2 ? choicesFor(versions, pair[1 - side] ?? "") : []}
                  labelOf={labelOf}
                  projection={projection}
                  withPrompt={withPrompts}
                  onPick={(id) => setPair(pickVersion(pair, side, id))}
                  onShow={() => show(version)}
                />
              );
            })}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function VersionColumn({
  side,
  version,
  choices,
  labelOf,
  projection,
  withPrompt,
  onPick,
  onShow,
}: {
  readonly side: 0 | 1;
  readonly version: CompareVersion;
  /** The dropdown's versions (more than two in all), else none. */
  readonly choices: readonly CompareVersion[];
  readonly labelOf: (messageId: string) => string | undefined;
  readonly projection: Projection;
  readonly withPrompt: boolean;
  readonly onPick: (id: string) => void;
  readonly onShow: () => void;
}) {
  const label = labelOf(version.id) ?? labelOf(version.answerId ?? "");
  const title = versionTitle(version, label);
  const answer = useThreadMessage(projection, version.answerId);
  const prompt = useThreadMessage(projection, withPrompt ? version.promptId : undefined);
  return (
    <section
      role="region"
      aria-label={label === undefined ? title : `Version ${version.k}, ${label}`}
      className={styles.column}
      data-kobe-compare-column={SIDES[side]}
    >
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
                {versionTitle(v, labelOf(v.id) ?? labelOf(v.answerId ?? ""))}
              </option>
            ))}
          </select>
        )}
        {answer !== null && (
          <MessageProvider message={answer} index={0}>
            <MessageFooter shown />
          </MessageProvider>
        )}
      </div>
      {prompt !== null && (
        <MessageProvider message={prompt} index={0}>
          <ReadOnlyPrompt />
        </MessageProvider>
      )}
      {answer === null ? (
        <p className={styles.empty}>No answer on this version.</p>
      ) : (
        <MessageProvider message={answer} index={0}>
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
