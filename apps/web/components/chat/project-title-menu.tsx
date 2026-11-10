"use client";

import { ChevronRightIcon } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import Link from "next/link";
import { useId, useState } from "react";
import type { ThreadController } from "../../lib/chat/thread-controller";
import type { ThreadState } from "../../lib/chat/thread-state";
import type { MenuChoice } from "../../lib/shell/menu";
import { chatPortalContainer } from "../ui/chat-portal";
import { useOrganizeMenu } from "./use-organize-menu";

const CONTENT = "bg-background text-foreground z-50 min-w-44 rounded-lg border p-1 shadow-md";
const ITEM =
  "hover:bg-muted focus:bg-muted data-[state=open]:bg-muted flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none aria-disabled:cursor-not-allowed aria-disabled:opacity-50";

/**
 * The project part of a created conversation's title (KOBE-589, TT2-TT3): a muted button that
 * opens Open project, Move to project… and Move out of the project. The two moves are the thread
 * menu's own (`useOrganizeMenu`: its choices, its busy rule, the same `POST /v1/threads/{id}/move`),
 * not a second copy. Unavailable moves stay focusable with their reason, as in the row menu.
 */
export function ProjectTitleMenu({
  state,
  controller,
  projectId,
  projectName,
  title,
}: {
  readonly state: ThreadState;
  readonly controller: ThreadController | null;
  readonly projectId: string;
  readonly projectName: string;
  readonly title: string;
}) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const reasonId = useId();
  const bindings = useOrganizeMenu({
    threadId: state.threadId ?? "",
    title,
    custom: undefined,
    open,
    readOnly: false,
    state,
    notify: (n) => setNotice(n.full),
    onMoved: () => {
      setNotice(null);
      void controller?.refresh();
    },
  });
  const move = bindings["move-thread"];
  const blocker = move?.blocker ?? null;
  const all: readonly MenuChoice[] = move?.choices ?? [];
  const out = all.find((c) => c.key === "");
  const targets = all.filter((c) => c.key !== "" && c.key !== projectId);
  const disabled = (e: Event) => {
    if (blocker !== null) e.preventDefault();
  };

  return (
    <>
      <DropdownMenu.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setNotice(null);
        }}
      >
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label={`Project ${projectName}`}
            title={projectName}
            className="text-muted-foreground hover:bg-muted focus-visible:ring-ring -mx-1 max-w-[40%] min-w-0 shrink truncate rounded-md px-1 text-start text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
          >
            {projectName}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal container={chatPortalContainer()}>
          <DropdownMenu.Content
            data-kobe-portal
            align="start"
            sideOffset={4}
            aria-label={`Project ${projectName}`}
            className={CONTENT}
          >
            <DropdownMenu.Item asChild className={ITEM}>
              {/* eslint-disable-next-line no-restricted-syntax -- a menu item that navigates, named by its text */}
              <Link href={`/me/projects/${projectId}`}>Open project</Link>
            </DropdownMenu.Item>
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger
                className={ITEM}
                aria-disabled={blocker !== null || undefined}
                aria-describedby={blocker !== null ? reasonId : undefined}
                title={blocker ?? undefined}
                disabled={false}
              >
                Move to project…
                <ChevronRightIcon aria-hidden className="ms-auto size-4" />
              </DropdownMenu.SubTrigger>
              {blocker === null && (
                <DropdownMenu.Portal container={chatPortalContainer()}>
                  <DropdownMenu.SubContent data-kobe-portal sideOffset={4} className={CONTENT}>
                    {targets.length === 0 && (
                      <DropdownMenu.Item disabled className={ITEM}>
                        No other projects
                      </DropdownMenu.Item>
                    )}
                    {targets.map((c) => (
                      <DropdownMenu.Item key={c.key} className={ITEM} onSelect={c.onSelect}>
                        {c.label}
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              )}
            </DropdownMenu.Sub>
            <DropdownMenu.Item
              className={ITEM}
              aria-disabled={blocker !== null || undefined}
              aria-describedby={blocker !== null ? reasonId : undefined}
              title={blocker ?? undefined}
              onSelect={(e) => {
                disabled(e);
                if (blocker === null) out?.onSelect();
              }}
            >
              Move out of the project
            </DropdownMenu.Item>
            {blocker !== null && (
              <span id={reasonId} hidden>
                {blocker}
              </span>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {notice !== null && (
        <span role="alert" className="text-destructive text-xs">
          {notice}
        </span>
      )}
    </>
  );
}
