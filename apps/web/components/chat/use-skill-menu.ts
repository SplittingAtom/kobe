"use client";

import { useAui } from "@assistant-ui/react";
import { useEffect, useState } from "react";
import { startSkillFromConversation } from "../../lib/skills/from-conversation";
import { saveWorkspaceSkill } from "../../lib/skills/drafts-api";
import { showSavedSkill } from "../../lib/skills/saved-notice";
import type { MenuBindings } from "../../lib/shell/menu";
import { useChatSession } from "./kobe-runtime";
import type { Notice } from "./use-thread-menu";

const LOADING = "Looking for skill folders in /workspace/skills…";
const NONE = "No skill folder in /workspace/skills yet: ask skill-creator to build one.";
const FAILED = "The skill folders could not be read. Open the menu again to retry.";

type Folders =
  | { readonly status: "loading" | "error" }
  | { readonly status: "ready"; readonly names: readonly string[] };

/** The folders under /workspace/skills, read while the menu is open. */
function useSkillFolders(open: boolean): Folders {
  const session = useChatSession();
  const [folders, setFolders] = useState<Folders>({ status: "loading" });
  useEffect(() => {
    if (!open) return;
    let current = true;
    void session.files.list("skills").then((res) => {
      if (!current) return;
      setFolders(
        res.ok
          ? {
              status: "ready",
              names: res.data.entries.filter((e) => e.type === "dir").map((e) => e.name),
            }
          : { status: "error" },
      );
    });
    return () => {
      current = false;
    };
  }, [open, session]);
  return folders;
}

/**
 * The thread menu's skill actions (KOBE-322, SK10): "Make a skill from this" opens a Workbench
 * conversation with this one attached and the request to skill-creator in its composer (sent by
 * the member, not by the menu); "Save skill to Workbench" lists the folders under
 * /workspace/skills and makes the chosen one a draft that records this conversation. The chat
 * stays open and shows a link to the draft (SavedSkillNotice).
 */
export function useSkillMenu(input: {
  readonly threadId: string | undefined;
  readonly title: string;
  readonly open: boolean;
  readonly notify: (notice: Notice) => void;
}): MenuBindings {
  const aui = useAui();
  const session = useChatSession();
  const folders = useSkillFolders(input.open);
  const { threadId, title, notify } = input;
  if (threadId === undefined) return {};

  const start = () => {
    notify({ short: "Starting…", full: `Starting a skill conversation from “${title}”.` });
    void startSkillFromConversation(
      {
        api: session.api,
        attach: (thread, file) => session.attachments.add(thread, [file], thread),
        prefill: (thread, text) => session.setComposerDraft(thread, text),
      },
      { threadId, title },
    ).then((res) => {
      if (!res.ok) {
        notify({ short: "Not started", full: res.error.message });
        return;
      }
      session.threadCreated();
      aui.threads.switchToThread(res.data.threadId);
      notify({
        short: "Skill conversation",
        full: `Opened a conversation for skill-creator with “${title}” attached: review the request and send it.`,
      });
    });
  };

  const save = (folder: string) => {
    void saveWorkspaceSkill(session.teamId, threadId, folder).then((res) => {
      if (!res.ok) {
        notify({ short: "Not saved", full: res.error.message });
        return;
      }
      notify({ short: "Saved", full: `Saved ${res.data.name} to your Workbench.` });
      showSavedSkill({ draftId: res.data.id, name: res.data.name, updated: res.status === 200 });
    });
  };

  const names = folders.status === "ready" ? folders.names : [];
  const blocker =
    folders.status === "loading"
      ? LOADING
      : folders.status === "error"
        ? FAILED
        : names.length === 0
          ? NONE
          : null;
  return {
    "skill-from-thread": { onSelect: start },
    "save-skill-to-workbench": {
      blocker,
      choices: names.map((name) => ({ key: name, label: name, onSelect: () => save(name) })),
    },
  };
}
