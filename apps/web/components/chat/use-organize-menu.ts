"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { ApiError } from "../../lib/api/client";
import { NOT_ORGANIZED, organizedMessage, type OrganizeChange } from "../../lib/chat/organize";
import { placementOf } from "../../lib/chat/thread-groups";
import { isThreadRunning, queuedRuns, type ThreadState } from "../../lib/chat/thread-state";
import type { Project } from "../../lib/projects/api";
import type { MenuBindings, MenuChoice } from "../../lib/shell/menu";
import { useChatSession } from "./kobe-runtime";

/**
 * Pin, Archive and Move to project in a thread row's menu (CE19, KOBE-220). The row offers Pin or
 * Unpin and Archive or Unarchive from its listed placement; Move lists the live projects the
 * member may start threads in (the server checks again and refuses the others). After a change
 * the rail reads its list again, so the row moves to its new group: the rail's live region says
 * what happened, and the focus follows the row (or its group, when that group is folded).
 */

/** The rail's announcer (a polite live region that outlives the rows). */
export const RailAnnounce = createContext<(text: string) => void>(() => {});

const NOT_YOURS = "This conversation is shared with you read-only: only its owner can organize it.";
const BUSY = "Wait for the current run to finish: it uses the current project.";
const LOADING = "Loading your projects…";
const FAILED = "Your projects could not be loaded. Open the menu again to retry.";
const NO_PROJECTS = "You have no projects to move it to.";

type Projects =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly projects: readonly Project[] };

/** The member's live projects, read while the menu is open. */
function useMovableProjects(open: boolean): Projects {
  const session = useChatSession();
  const [projects, setProjects] = useState<Projects>({ status: "loading" });
  useEffect(() => {
    if (!open) return;
    let current = true;
    setProjects((p) => (p.status === "ready" ? p : { status: "loading" }));
    void session.projects().then((res) => {
      if (!current) return;
      if (!res.ok) console.warn("thread menu: could not read the projects", res.error);
      setProjects(res.ok ? { status: "ready", projects: res.data } : { status: "error" });
    });
    return () => {
      current = false;
    };
  }, [session, open]);
  return projects;
}

/** Why Move can't run from what the open thread shows, or null (the server decides the rest). */
function moveBlocker(projects: Projects, state: ThreadState | undefined, inProject: boolean) {
  if (state?.summary && (state.summary.status === "running" || isThreadRunning(state))) return BUSY;
  if (state && queuedRuns(state).length > 0) return BUSY;
  if (projects.status === "loading") return LOADING;
  if (projects.status === "error") return FAILED;
  return projects.projects.length === 0 && !inProject ? NO_PROJECTS : null;
}

function refusal(change: OrganizeChange, error: ApiError): string {
  if (change.action === "move" && error.code === "project_not_found") {
    return "You can't start conversations in that project, so this one can't move there.";
  }
  return error.message;
}

const rowButton = (threadId: string) =>
  document.querySelector<HTMLElement>(
    `[data-kobe-thread="${CSS.escape(threadId)}"] button[aria-haspopup="menu"]`,
  );

/**
 * Once the list re-read and the row moved to its new group (its old button is gone, so the focus
 * fell to the page), focus its menu button there, or its group's toggle while that group is
 * folded. Never takes the focus from somewhere the member moved it.
 */
function followRow(threadId: string, group: "pinned" | "archived" | null) {
  const origin = rowButton(threadId);
  let frames = 60;
  const step = () => {
    const active = document.activeElement;
    const lost = active === null || active === document.body;
    if (lost) {
      const toggle = group
        ? document.querySelector<HTMLElement>(`[data-group="${group}"] button[aria-expanded]`)
        : null;
      const target = rowButton(threadId) ?? toggle;
      if (target) return target.focus();
    } else if (active !== origin) return;
    frames -= 1;
    if (frames > 0) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export interface OrganizeMenuInput {
  readonly threadId: string;
  readonly title: string;
  /** The row's `custom` from the list (`placementCustom`). */
  readonly custom: unknown;
  readonly open: boolean;
  readonly readOnly: boolean;
  readonly state: ThreadState | undefined;
  readonly notify: (notice: { readonly short: string; readonly full: string }) => void;
}

export function useOrganizeMenu(input: OrganizeMenuInput): MenuBindings {
  const session = useChatSession();
  const announce = useContext(RailAnnounce);
  const projects = useMovableProjects(input.open);
  const { threadId, title, readOnly, state, notify } = input;
  const placement = placementOf(input.custom);
  const projectId = state?.summary?.projectId ?? placement.projectId;

  const apply = (change: OrganizeChange, projectName?: string) => {
    void session.organize(threadId, change).then(
      (res) => {
        if (!res.ok) {
          const full = refusal(change, res.error);
          notify({ short: NOT_ORGANIZED[change.action], full });
          announce(full);
          return;
        }
        announce(organizedMessage(change, title, projectName));
        const group =
          change.action === "pin" ? "pinned" : change.action === "archive" ? "archived" : null;
        followRow(threadId, group);
      },
      () => notify({ short: NOT_ORGANIZED[change.action], full: `“${title}” was not changed.` }),
    );
  };

  if (readOnly) {
    return { "pin-thread": { blocker: NOT_YOURS }, "archive-thread": { blocker: NOT_YOURS } };
  }
  const choices: readonly MenuChoice[] =
    projects.status !== "ready"
      ? []
      : [
          {
            key: "",
            label: "No project",
            current: projectId === null,
            onSelect: () => apply({ action: "move", projectId: null }),
          },
          ...projects.projects.map((p) => ({
            key: p.id,
            label: p.name,
            current: p.id === projectId,
            onSelect: () => apply({ action: "move", projectId: p.id }, p.name),
          })),
        ];
  return {
    ...(placement.pinned
      ? { "unpin-thread": { onSelect: () => apply({ action: "unpin" }) } }
      : placement.archived
        ? {}
        : { "pin-thread": { onSelect: () => apply({ action: "pin" }) } }),
    "move-thread": { choices, blocker: moveBlocker(projects, state, projectId !== null) },
    ...(placement.archived
      ? { "unarchive-thread": { onSelect: () => apply({ action: "unarchive" }) } }
      : { "archive-thread": { onSelect: () => apply({ action: "archive" }) } }),
  };
}
