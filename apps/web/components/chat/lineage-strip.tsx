"use client";

import { CheckIcon, ChevronDownIcon, GitForkIcon } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useContext, useState, type MouseEvent, type ReactNode } from "react";
import type { ThreadLineageResponse } from "@kobe/protocol";
import { HIDDEN_SOURCE, forkPointExcerpt } from "../../lib/chat/fork";
import {
  LINEAGE_EXCERPT_MAX,
  familyItems,
  foldLabel,
  forksLabel,
  hasLineage,
  lineageRows,
  siblingLabel,
  type LineageRow,
  type LineageThread,
  type SiblingChoice,
} from "../../lib/chat/lineage";
import { useLineage } from "../../lib/chat/use-lineage";
import { InlineLink } from "../shell/text-links";
import { useShellBand } from "../shell/shell-band";
import { chatPortalContainer } from "../ui/chat-portal";
import { OpenThreadContext } from "./fork-dialog";
import { ChatSessionContext, type KobeThreadExtras } from "./kobe-runtime";
import styles from "./chat.module.css";

const CONTENT =
  "bg-background text-foreground z-50 max-h-80 min-w-44 max-w-[min(28rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border p-1 shadow-md";
const ITEM =
  "hover:bg-muted focus:bg-muted flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-[disabled]:cursor-default data-[disabled]:opacity-70";
const TRIGGER =
  "hover:bg-muted focus-visible:ring-ring inline-flex min-w-0 items-center gap-1 rounded-md px-1 text-start focus-visible:ring-2 focus-visible:outline-none";
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
  return thread.inTrash ? <span className="text-muted-foreground"> · In Trash</span> : null;
}

/** An ancestor's title: a link that opens in place; a modified click keeps the browser's own. */
function ThreadLink({ thread, open }: { readonly thread: LineageThread; readonly open: Open }) {
  return (
    <span className="min-w-0">
      <InlineLink
        href={`/?thread=${encodeURIComponent(thread.threadId)}`}
        onClick={(e: MouseEvent<HTMLAnchorElement>) => {
          const plain = e.button === 0 && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);
          if (!plain) return;
          e.preventDefault();
          open(thread.threadId);
        }}
      >
        {thread.title}
      </InlineLink>
      <TrashNote thread={thread} />
    </span>
  );
}

/** A dropdown of the strip (Radix menu button, in the chat's portal). */
function StripMenu({
  label,
  bold = false,
  children,
}: {
  readonly label: ReactNode;
  readonly bold?: boolean;
  readonly children: ReactNode;
}) {
  // Controlled, so opening renders again and the portal finds the chat root mounted by then.
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={`${TRIGGER} ${bold ? "text-foreground font-semibold" : ""}`}
        >
          <span className="min-w-0">{label}</span>
          <ChevronDownIcon aria-hidden className="size-3.5 shrink-0" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={chatPortalContainer()}>
        <DropdownMenu.Content data-kobe-portal align="start" sideOffset={4} className={CONTENT}>
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
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

/** Siblings, newest first, the one in the path checked; choosing another opens it. */
function SiblingsMenu({
  thread,
  choice,
  open,
  bold,
  onScreen,
}: {
  readonly thread: LineageThread;
  readonly choice: SiblingChoice;
  readonly open: Open;
  readonly bold: boolean;
  readonly onScreen: string;
}) {
  return (
    <StripMenu label={siblingLabel(thread.title, choice)} bold={bold}>
      <DropdownMenu.RadioGroup value={thread.threadId}>
        {choice.items.map((s) => (
          <DropdownMenu.RadioItem
            key={s.threadId}
            value={s.threadId}
            className={ITEM}
            onSelect={() => {
              if (s.threadId !== onScreen) open(s.threadId);
            }}
          >
            <Check />
            <span className="min-w-0">
              {s.title}
              <TrashNote thread={s} />
            </span>
          </DropdownMenu.RadioItem>
        ))}
      </DropdownMenu.RadioGroup>
    </StripMenu>
  );
}

function ThreadItems({
  threads,
  open,
}: {
  readonly threads: readonly LineageThread[];
  readonly open: Open;
}) {
  return threads.map((t) => (
    <DropdownMenu.Item key={t.threadId} className={ITEM} onSelect={() => open(t.threadId)}>
      <span className="min-w-0">
        {t.title}
        <TrashNote thread={t} />
      </span>
    </DropdownMenu.Item>
  ));
}

function RowBody({
  row,
  excerpt,
  open,
  onScreen,
}: {
  readonly row: LineageRow;
  readonly excerpt: string | null;
  readonly open: Open;
  readonly onScreen: string;
}) {
  switch (row.kind) {
    case "hidden":
      return <span className="text-muted-foreground italic">{HIDDEN_SOURCE}</span>;
    case "ancestor":
      return row.siblings === null ? (
        <ThreadLink thread={row.thread} open={open} />
      ) : (
        <SiblingsMenu
          thread={row.thread}
          choice={row.siblings}
          open={open}
          bold={false}
          onScreen={onScreen}
        />
      );
    case "fold":
      return (
        <StripMenu label={foldLabel(row.folded.length)}>
          <ThreadItems threads={row.folded} open={open} />
        </StripMenu>
      );
    case "self":
      return (
        <span className="min-w-0">
          {row.siblings === null ? (
            <strong className="text-foreground" aria-current="page">
              {row.thread.title}
            </strong>
          ) : (
            <SiblingsMenu
              thread={row.thread}
              choice={row.siblings}
              open={open}
              bold
              onScreen={onScreen}
            />
          )}
          {row.forkedAt !== null && excerpt !== null && <> at “{excerpt}”</>}
        </span>
      );
    case "forks": {
      const [only] = row.forks;
      if (row.forks.length === 1 && !row.more && only) {
        return (
          <span className="min-w-0">
            1 fork: <ThreadLink thread={only} open={open} />
          </span>
        );
      }
      return (
        <StripMenu label={forksLabel(row.forks.length, row.more)}>
          <ThreadItems threads={row.forks} open={open} />
        </StripMenu>
      );
    }
  }
}

/** Under 820 px: one line whose menu holds the whole family, in the strip's order (TL3). */
function FamilyLine({
  lineage,
  open,
}: {
  readonly lineage: ThreadLineageResponse;
  readonly open: Open;
}) {
  const { items, related } = familyItems(lineage);
  const isFork = lineage.ancestors.length > 0 || lineage.root_hidden;
  return (
    <p className={styles.lineageRow}>
      <GitForkIcon aria-hidden className="size-3.5 shrink-0 self-center" />
      <StripMenu label={`${isFork ? "Forked thread" : "Thread with forks"} · ${related} related`}>
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
                <TrashNote thread={t} />
              </span>
            </DropdownMenu.CheckboxItem>
          );
        })}
      </StripMenu>
    </p>
  );
}

/**
 * The strip itself, from a lineage answer (TL3): nothing for an ordinary thread; else one row
 * per generation, root first, the thread on screen bold with its fork point, then its forks; or,
 * when `compact` (under 820 px), one line with the family in a menu.
 */
export function LineageStripView({
  lineage,
  excerpt,
  compact,
  onOpenThread,
}: {
  readonly lineage: ThreadLineageResponse;
  /** The fork point's excerpt from the thread's own projection; null when not loaded. */
  readonly excerpt: string | null;
  readonly compact: boolean;
  readonly onOpenThread?: Open | undefined;
}) {
  if (!hasLineage(lineage)) return null;
  const open = opener(onOpenThread);
  return (
    <nav aria-label="Thread lineage" className="py-1">
      {compact ? (
        <FamilyLine lineage={lineage} open={open} />
      ) : (
        <ol className="m-0 list-none p-0">
          {lineageRows(lineage).map((row) => (
            <li
              key={`${row.kind}-${row.depth}`}
              className={styles.lineageRow}
              style={{ paddingInlineStart: `${row.depth * INDENT_REM}rem` }}
            >
              {row.depth > 0 && (
                <GitForkIcon aria-hidden className="size-3.5 shrink-0 self-center" />
              )}
              <RowBody row={row} excerpt={excerpt} open={open} onScreen={lineage.self.thread_id} />
            </li>
          ))}
        </ol>
      )}
    </nav>
  );
}

/**
 * The lineage strip above the conversation (TL3, TL4, KOBE-535; replaces the "Forked from" note):
 * reads the thread's family when it opens and on the TL4 triggers, opens threads in place
 * through `OpenThreadContext`, and shows nothing while there is nothing to show or a read failed.
 */
export function LineageStrip({ extras }: { readonly extras: KobeThreadExtras }) {
  const session = useContext(ChatSessionContext);
  const onOpenThread = useContext(OpenThreadContext);
  const band = useShellBand();
  const lineage = useLineage(extras.state.threadId, session);
  if (lineage === null) return null;
  const excerpt = forkPointExcerpt(
    extras.projection,
    lineage.self.forked_at_entry_id,
    LINEAGE_EXCERPT_MAX,
  );
  return (
    <LineageStripView
      lineage={lineage}
      excerpt={excerpt}
      compact={band === "overlay" || band === "single"}
      onOpenThread={onOpenThread}
    />
  );
}
