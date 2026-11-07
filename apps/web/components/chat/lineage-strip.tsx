"use client";

import { CheckIcon, ChevronDownIcon, GitForkIcon } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useContext, useState } from "react";
import type { ThreadLineageResponse } from "@kobe/protocol";
import { HIDDEN_SOURCE } from "../../lib/chat/fork";
import {
  familyItems,
  forksLabel,
  hasLineage,
  lineageParent,
  type LineageThread,
} from "../../lib/chat/lineage";
import { useLineage } from "../../lib/chat/use-lineage";
import { chatPortalContainer } from "../ui/chat-portal";
import { useTreeData } from "./tree-context";
import { OpenThreadContext } from "./fork-dialog";
import { ChatSessionContext, type KobeThreadExtras } from "./kobe-runtime";

const CONTENT =
  "bg-background text-foreground z-50 max-h-80 min-w-44 max-w-[min(28rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border p-1 shadow-md";
const ITEM =
  "hover:bg-muted focus:bg-muted flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-[disabled]:cursor-default data-[disabled]:opacity-70";
/**
 * The chip (Chris 2026-11-06): the fork icon first, sharp corners, the page's colours inverted
 * (the foreground as its fill, the page colour as its text) so it stands out against the page in
 * every theme.
 */
const CHIP =
  "bg-foreground text-background hover:bg-foreground/85 focus-visible:ring-ring inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-none px-2 py-0.5 text-xs font-medium focus-visible:ring-2 focus-visible:outline-none";
const INDENT_REM = 1;

type Open = (threadId: string) => void;

/** Opens a thread: in place in the chat, else as a page (outside the shell). */
function opener(onOpenThread: Open | undefined): Open {
  return (threadId) => {
    if (onOpenThread) onOpenThread(threadId);
    else window.location.assign(`/?thread=${encodeURIComponent(threadId)}`);
  };
}

function TrashNote({ thread }: { readonly thread: LineageThread }) {
  return thread.inTrash ? <span className="opacity-70"> · In Trash</span> : null;
}

function Check() {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      <DropdownMenu.ItemIndicator>
        <CheckIcon aria-hidden className="size-4" />
      </DropdownMenu.ItemIndicator>
    </span>
  );
}

/** What the chip says: the parent, a hidden source, or (a root with forks) its forks. */
function ChipLabel({ lineage }: { readonly lineage: ThreadLineageResponse }) {
  const parent = lineageParent(lineage);
  if (parent !== null) {
    return (
      <>
        <span className="sr-only">Forked from </span>
        <span className="min-w-0 truncate">
          {parent.title}
          <TrashNote thread={parent} />
        </span>
      </>
    );
  }
  if (lineage.root_hidden) {
    return (
      <>
        <span className="sr-only">Forked from </span>
        <span className="min-w-0 truncate italic">{HIDDEN_SOURCE}</span>
      </>
    );
  }
  return (
    <span className="min-w-0 truncate">{forksLabel(lineage.forks.length, lineage.forks_more)}</span>
  );
}

/**
 * The chip: one button naming the thread's parent (or its forks), whose menu holds the whole
 * family in generation order (indented, the path checked); choosing another thread opens it.
 */
function FamilyChip({
  lineage,
  open,
}: {
  readonly lineage: ThreadLineageResponse;
  readonly open: Open;
}) {
  const { items } = familyItems(lineage);
  // Controlled, so opening renders again and the portal finds the chat root mounted by then.
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className={CHIP} data-kobe-lineage-chip>
          <GitForkIcon aria-hidden className="size-3.5 shrink-0" />
          <ChipLabel lineage={lineage} />
          <ChevronDownIcon aria-hidden className="size-3.5 shrink-0" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={chatPortalContainer()}>
        <DropdownMenu.Content data-kobe-portal align="start" sideOffset={4} className={CONTENT}>
          {items.map((item, i) => {
            const indent = { paddingInlineStart: `${0.5 + item.depth * INDENT_REM}rem` };
            if (item.thread === null) {
              return (
                <DropdownMenu.Item key="hidden" disabled className={ITEM} style={indent}>
                  <span className="text-muted-foreground italic">{HIDDEN_SOURCE}</span>
                </DropdownMenu.Item>
              );
            }
            const t = item.thread;
            return (
              <DropdownMenu.CheckboxItem
                key={`${t.threadId}-${i}`}
                checked={item.inPath}
                className={ITEM}
                style={indent}
                onSelect={() => {
                  if (!item.current) open(t.threadId);
                }}
              >
                <Check />
                <span className={`min-w-0 ${item.current ? "font-semibold" : ""}`}>
                  {t.title}
                  {t.inTrash && <span className="text-muted-foreground"> · In Trash</span>}
                </span>
              </DropdownMenu.CheckboxItem>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * The strip itself, from a lineage answer (TL3 as amended 2026-11-06): nothing for an ordinary
 * thread; else one chip naming the parent (or the forks of a root), its menu the whole family.
 */
export function LineageStripView({
  lineage,
  onOpenThread,
}: {
  readonly lineage: ThreadLineageResponse;
  readonly onOpenThread?: Open | undefined;
}) {
  if (!hasLineage(lineage)) return null;
  return (
    <nav aria-label="Thread lineage" className="py-1">
      <FamilyChip lineage={lineage} open={opener(onOpenThread)} />
    </nav>
  );
}

/**
 * The lineage chip above the conversation (TL3, TL4, KOBE-535; replaces the "Forked from" note):
 * reads the thread's family when it opens and on the TL4 triggers, opens threads in place
 * through `OpenThreadContext`, and shows nothing while there is nothing to show or a read failed.
 */
export function LineageStrip({ extras }: { readonly extras: KobeThreadExtras }) {
  const session = useContext(ChatSessionContext);
  const onOpenThread = useContext(OpenThreadContext);
  // The Conversation tree's host reads the lineage once for both (KOBE-546); alone, its own read.
  const host = useTreeData();
  const own = useLineage(host ? null : extras.state.threadId, host ? null : session);
  const lineage = host ? host.lineage : own;
  if (lineage === null) return null;
  return <LineageStripView lineage={lineage} onOpenThread={onOpenThread} />;
}
