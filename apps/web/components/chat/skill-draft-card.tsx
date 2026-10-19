"use client";

import { useContext, useEffect, useState } from "react";
import { WandSparklesIcon } from "lucide-react";
import { recordedSkillDraftSaves, type SavedSkillDraft } from "../../lib/skills/draft-tool-result";
import { draftHref } from "../skills/draft-href";
import { InlineLink } from "../shell/text-links";
import { ChatSessionContext, useKobeExtras } from "./kobe-runtime";
import styles from "./chat.module.css";

export const NEW_DRAFT_NOTE = "Your earlier draft was shared or edited, so this is a new draft.";

/** The server's record of this call's save, once the call has a result (KOBE-442 review L4). */
function useRecordedSave(toolCallId: string, done: boolean): SavedSkillDraft | undefined {
  const teamId = useContext(ChatSessionContext)?.teamId;
  const threadId = useKobeExtras()?.state.threadId ?? undefined;
  const [save, setSave] = useState<SavedSkillDraft | undefined>(undefined);
  useEffect(() => {
    if (!done || !teamId || !threadId) return;
    let live = true;
    void recordedSkillDraftSaves(teamId, threadId).then((res) => {
      if (live && res.ok) setSave(res.data.find((s) => s.toolCallId === toolCallId));
    });
    return () => {
      live = false;
    };
  }, [teamId, threadId, toolCallId, done]);
  return save;
}

/**
 * The card under a `save_skill_draft` call (KOBE-442): the member's private draft, with a link to
 * it in the Workbench, where they test it, run its evals and save a version. Built only from the
 * server's own record of the save, so it shows on a recorded thread as well as live.
 */
export function SkillDraftCard({
  toolCallId,
  done,
}: {
  readonly toolCallId: string;
  readonly done: boolean;
}) {
  const draft = useRecordedSave(toolCallId, done);
  if (!draft) return null;
  return (
    <div className={styles.fileCard}>
      <WandSparklesIcon aria-hidden className="size-4" />
      <div className={styles.fileInfo}>
        <span className={styles.fileName}>
          Skill draft {draft.created ? "saved" : "updated"}: {draft.name}
        </span>
        {draft.newBecause && <span className={styles.fileMeta}>{NEW_DRAFT_NOTE}</span>}
        <span className={styles.fileMeta}>Private to you until you save a version.</span>
      </div>
      <InlineLink href={draftHref(draft.draftId)}>Open in Workbench</InlineLink>
    </div>
  );
}
