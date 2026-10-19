"use client";

import { useSyncExternalStore } from "react";
import { clearSavedSkill, savedSkill, subscribeSavedSkill } from "../../lib/skills/saved-notice";
import { draftHref } from "../skills/draft-href";
import { IconAction } from "../shell/icon-action";
import { InlineLink } from "../shell/text-links";
import styles from "./chat.module.css";

/**
 * After "Save skill to Workbench" (KOBE-322): the conversation stays on screen with a link to the
 * draft, so the member can keep talking to skill-creator and open the Workbench when ready.
 */
export function SavedSkillNotice() {
  const saved = useSyncExternalStore(subscribeSavedSkill, savedSkill, () => null);
  if (!saved) return null;
  return (
    <div className={styles.noteBanner} role="status">
      <p>
        {saved.updated ? "Updated" : "Saved"} {saved.name} in your Workbench.{" "}
        <InlineLink href={draftHref(saved.draftId)}>Open the draft</InlineLink>
      </p>
      <IconAction
        command="dismiss-notice"
        label="Dismiss saved skill notice"
        size="sm"
        className="shrink-0"
        onClick={clearSavedSkill}
      />
    </div>
  );
}
