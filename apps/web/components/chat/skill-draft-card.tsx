"use client";

import { WandSparklesIcon } from "lucide-react";
import { skillDraftFromToolResult } from "../../lib/skills/draft-tool-result";
import { draftHref } from "../skills/draft-href";
import { InlineLink } from "../shell/text-links";
import styles from "./chat.module.css";

/**
 * The card under a `save_skill_draft` call (KOBE-442): the member's private draft, with a link to
 * it in the Workbench, where they test it, run its evals and save a version. Read from the tool's
 * result, so it shows on a recorded thread as well as live.
 */
export function SkillDraftCard({ result }: { readonly result: unknown }) {
  const draft = skillDraftFromToolResult(result);
  if (!draft) return null;
  return (
    <div className={styles.fileCard}>
      <WandSparklesIcon aria-hidden className="size-4" />
      <div className={styles.fileInfo}>
        <span className={styles.fileName}>
          Skill draft {draft.created ? "saved" : "updated"}: {draft.name}
        </span>
        <span className={styles.fileMeta}>Private to you until you save a version.</span>
      </div>
      <InlineLink href={draftHref(draft.draftId)}>Open in Workbench</InlineLink>
    </div>
  );
}
