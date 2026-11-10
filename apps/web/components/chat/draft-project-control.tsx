"use client";

import { Popover } from "radix-ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { command } from "../../lib/shell/commands";
import type { MenuChoice } from "../../lib/shell/menu";
import { chatPortalContainer } from "../ui/chat-portal";
import { IconAction } from "../shell/icon-action";
import { useBindCommands } from "../shell/command-bindings";
import { useChatSession } from "./kobe-runtime";
import {
  useDraftProjectName,
  useDraftProjectState,
  useWorkspaceProjects,
} from "./use-draft-project";

/** More projects than this and the menu gets a filter field (NC2). */
export const FILTER_AFTER = 8;
const PRIVACY = "It stays private until you share it.";
const PALETTE_LABEL = "Choose the project for this conversation";
const REMOVE = "Remove project";

/** The words under the icon: what a refused send says about the project (NC5). */
export function projectIssueText(
  issue: { readonly kind: string; readonly message: string },
  name: string | null,
): string {
  return issue.kind === "too_many_mounts"
    ? issue.message
    : `You can no longer start conversations in ${name ?? "this project"}.`;
}

/**
 * The project control of a conversation not created yet (KOBE-588, NC2-NC3, NC5): an icon button
 * that opens the workspace's projects (a radio each, the chosen one checked; a filter past eight)
 * and Remove project. It only changes the session's draft project: nothing mounts before the first
 * send. Also bound to the command palette. A refused send is said beside it, with Remove project.
 */
export function DraftProjectControl() {
  const session = useChatSession();
  const { projectId, issue } = useDraftProjectState();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const projects = useWorkspaceProjects(true);
  const name = useDraftProjectName(projectId);
  const listId = useId();
  const removeRef = useRef<HTMLButtonElement>(null);

  const sorted = useMemo(
    () => [...(projects ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [projects],
  );
  const shown = sorted.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => {
    if (issue !== null) removeRef.current?.focus();
  }, [issue]);

  const choices: readonly MenuChoice[] = [
    ...sorted.map((p) => ({
      key: p.id,
      label: p.name,
      current: p.id === projectId,
      onSelect: () => session.setDraftProject(p.id),
    })),
    ...(projectId === null
      ? []
      : [{ key: "none", label: REMOVE, onSelect: () => session.setDraftProject(null) }]),
  ];
  useBindCommands({ "draft-project": { label: PALETTE_LABEL, choices } });

  const label = projectId === null ? "Add to a project" : command("draft-project").name;
  const pick = (id: string | null) => {
    session.setDraftProject(id);
    setOpen(false);
  };

  return (
    <span className="flex min-w-0 items-center gap-1">
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
      >
        <Popover.Trigger asChild>
          <IconAction
            command="draft-project"
            label={label}
            description={PRIVACY}
            size="sm"
            aria-haspopup="dialog"
          />
        </Popover.Trigger>
        <Popover.Portal container={chatPortalContainer()}>
          <Popover.Content
            data-kobe-portal
            align="start"
            sideOffset={4}
            className="bg-background text-foreground z-50 flex w-64 flex-col gap-1 rounded-lg border p-2 shadow-md"
          >
            {sorted.length > FILTER_AFTER && (
              <input
                type="search"
                aria-label="Filter projects"
                placeholder="Filter projects"
                className="bg-background mb-1 rounded-md border px-2 py-1 text-sm"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            )}
            <div
              role="radiogroup"
              aria-label="Project for this conversation"
              className="flex max-h-56 flex-col overflow-y-auto"
            >
              {projects === null && <p className="text-muted-foreground px-2 text-sm">Loading…</p>}
              {projects !== null && shown.length === 0 && (
                <p className="text-muted-foreground px-2 text-sm">No projects.</p>
              )}
              {shown.map((p) => (
                <label
                  key={p.id}
                  className="hover:bg-muted has-[:focus-visible]:ring-ring flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm has-[:focus-visible]:ring-2"
                >
                  <input
                    type="radio"
                    name={listId}
                    className="accent-foreground"
                    checked={p.id === projectId}
                    onChange={() => pick(p.id)}
                  />
                  <span className="min-w-0 truncate">{p.name}</span>
                </label>
              ))}
            </div>
            {projectId !== null && (
              <button
                type="button"
                className="hover:bg-muted rounded-md px-2 py-1.5 text-start text-sm"
                onClick={() => pick(null)}
              >
                {REMOVE}
              </button>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {issue !== null && (
        <span role="alert" className="text-destructive flex flex-wrap items-center gap-x-2 text-xs">
          {projectIssueText(issue, name)}
          <button
            ref={removeRef}
            type="button"
            className="underline"
            onClick={() => session.setDraftProject(null)}
          >
            {REMOVE}
          </button>
        </span>
      )}
    </span>
  );
}
