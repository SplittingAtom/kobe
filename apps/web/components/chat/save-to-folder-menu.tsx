"use client";

import { useContext } from "react";
import type { ApiError } from "../../lib/api/client";
import { folderPath, placeFolders } from "../../lib/chat/folder-tree";
import { foldersOf } from "../../lib/chat/folders-store";
import { placementOf } from "../../lib/chat/thread-groups";
import type { ThreadState } from "../../lib/chat/thread-state";
import type { MenuBindings, MenuChoice } from "../../lib/shell/menu";
import { useChatSession } from "./kobe-runtime";
import { RailAnnounce } from "./use-organize-menu";
import { useThreadFolders } from "./use-thread-folders";

const IN_TRASH = "Restore the conversation first.";
const TEST_CHAT = "A Workbench test chat can't be put in a folder.";
const LOADING = "Loading the folders…";
const FAILED = "The folders could not be loaded. Open the menu again to retry.";
const NEW_FOLDER_PROMPT = "Name the new folder";

/** "Saved “Budget” to Folder A" (TF8), or what taking it out says. */
export function filedMessage(title: string, folderName: string | null, from?: string): string {
  if (folderName !== null) return `Saved “${title}” to ${folderName}.`;
  return from ? `Removed “${title}” from ${from}. It is in Current.` : `“${title}” is in Current.`;
}

function refusal(error: ApiError): string {
  if (error.code === "folder_not_found") return "That folder is gone. Choose another one.";
  return error.message;
}

export interface SaveToFolderInput {
  readonly threadId: string;
  readonly title: string;
  readonly custom: unknown;
  readonly state: ThreadState | undefined;
  /** The menu (or a listing of actions) is open: the folders are read. */
  readonly open: boolean;
  readonly notify: (notice: { readonly short: string; readonly full: string }) => void;
}

/**
 * Save to folder… in a thread's menus (KOBE-536, TF8): the team's folders as an indented list,
 * "New folder…" last, "Remove from folder" when the thread is in one. Offered on the member's own
 * threads and on the ones shared with them (readers may file, TF3); the server decides each.
 */
export function useSaveToFolderMenu(input: SaveToFolderInput): MenuBindings {
  const session = useChatSession();
  const announce = useContext(RailAnnounce);
  const folders = useThreadFolders(input.open);
  const { threadId, title, state, notify } = input;
  const placement = placementOf(input.custom);
  const summary = state?.summary;
  const current = summary?.folderId !== undefined ? summary.folderId : placement.folderId;
  const list = foldersOf(folders);

  const file = (folderId: string | null, name: string | null) => {
    const from = folderPath(list, current ?? null) ?? undefined;
    void session.file(threadId, folderId).then((res) => {
      if (!res.ok) {
        const full = refusal(res.error);
        notify({ short: "Not saved", full });
        announce(full);
        return;
      }
      announce(filedMessage(title, name, from));
    });
  };

  const createAndFile = () => {
    const name = window.prompt(NEW_FOLDER_PROMPT)?.trim();
    if (!name) return;
    void session.folders.create(name, null).then((res) => {
      if (!res.ok) {
        notify({ short: "No folder", full: res.error.message });
        announce(res.error.message);
        return;
      }
      file(res.data.id, res.data.name);
    });
  };

  const blocker =
    summary?.deletedAt != null
      ? IN_TRASH
      : summary?.skillTest === true || placement.workbench
        ? TEST_CHAT
        : folders.status === "idle" || (folders.status === "loading" && list.length === 0)
          ? LOADING
          : folders.status === "error" && list.length === 0
            ? FAILED
            : null;
  const choices: MenuChoice[] = placeFolders(list).map((p) => ({
    key: p.folder.id,
    label: p.folder.name,
    depth: p.depth - 1,
    current: p.folder.id === current,
    onSelect: () => file(p.folder.id, p.folder.name),
  }));
  choices.push({ key: "new", label: "New folder…", onSelect: createAndFile });
  if (current != null) {
    choices.push({ key: "remove", label: "Remove from folder", onSelect: () => file(null, null) });
  }
  return { "save-to-folder": { choices, blocker } };
}
