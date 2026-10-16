"use client";

import {
  ComposerPrimitive,
  useAui,
  useAuiState,
  type TriggerAdapter,
  type TriggerItem,
} from "@assistant-ui/react";
import { FileIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState, type RefObject } from "react";
import type { FilesApi } from "../../lib/files/api";
import {
  fileItem,
  MENTION_TRIGGER,
  mentionFormatter,
  mentionQueryAt,
  mentionsIn,
  withoutMention,
} from "../../lib/chat/mentions";

/** Wait after the last keystroke before asking the server. */
const SEARCH_DEBOUNCE_MS = 120;
const RESULTS = 20;

interface Found {
  readonly query: string;
  readonly items: readonly TriggerItem[];
}

/**
 * The query of the `@` being typed (null when none), from the composer text and the input's caret,
 * and the server's matches for it. Previous matches stay while the next ones load.
 */
function useMentionSearch(
  files: FilesApi,
  input: RefObject<HTMLTextAreaElement | null>,
): { readonly found: Found | undefined; readonly loading: boolean } {
  const text = useAuiState((s) => s.composer.text);
  const [query, setQuery] = useState<string | null>(null);
  const [found, setFound] = useState<Found | undefined>(undefined);
  useEffect(() => {
    setQuery(mentionQueryAt(text, input.current?.selectionStart ?? text.length));
  }, [text, input]);
  useEffect(() => {
    if (query === null) return;
    let live = true;
    const timer = setTimeout(() => {
      void files.search(query, RESULTS).then(
        (res) => {
          if (!live) return;
          setFound({ query, items: res.ok ? res.data.entries.map(fileItem) : [] });
        },
        () => {
          if (live) setFound({ query, items: [] });
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [files, query]);
  const current = query === null ? undefined : found;
  return { found: current, loading: query !== null && current?.query !== query };
}

/**
 * The `@` picker (CE22, KOBE-223) on assistant-ui's trigger popover: a listbox of the member's
 * workspace files (own files, project mounts, uploads) under the composer's `TriggerPopoverRoot`.
 * The input is the combobox (ARIA wired by `ComposerPrimitive.Input`): arrows move, Enter or Tab
 * picks, Escape closes. Picking writes the protocol's `@file(...)` marker into the text; the
 * server turns it into the absolute sandbox path. The popover stays closed while there is nothing
 * to pick, so Enter still sends a message that merely contains an `@`.
 */
export function MentionPicker({
  files,
  input,
}: {
  readonly files: FilesApi;
  readonly input: RefObject<HTMLTextAreaElement | null>;
}) {
  const { found, loading } = useMentionSearch(files, input);
  const items = found?.items;
  const adapter = useMemo<TriggerAdapter | undefined>(
    () =>
      items === undefined || items.length === 0
        ? undefined
        : { categories: () => [], categoryItems: () => [], search: () => items },
    [items],
  );
  return (
    <ComposerPrimitive.TriggerPopover
      char={MENTION_TRIGGER}
      adapter={adapter}
      isLoading={loading}
      aria-label="Workspace files"
      className="bg-popover text-popover-foreground border-foreground/10 absolute bottom-full left-0 z-20 mb-2 max-h-72 w-full overflow-y-auto rounded-xl border p-1 shadow-lg"
    >
      <ComposerPrimitive.TriggerPopover.Directive formatter={mentionFormatter} />
      <ComposerPrimitive.TriggerPopoverItems aria-label="Files">
        {(list) =>
          list.map((item, index) => (
            <ComposerPrimitive.TriggerPopoverItem
              key={item.id}
              item={item}
              index={index}
              className="data-[highlighted]:bg-muted flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-start text-sm"
            >
              <FileIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
              <span className="truncate font-medium">{item.label}</span>
              <span className="text-muted-foreground ms-auto truncate text-xs">
                {item.description}
              </span>
            </ComposerPrimitive.TriggerPopoverItem>
          ))
        }
      </ComposerPrimitive.TriggerPopoverItems>
    </ComposerPrimitive.TriggerPopover>
  );
}

const CHIP =
  "border-foreground/10 bg-background flex min-w-0 max-w-64 items-center gap-1.5 rounded-lg border px-2 py-1 text-xs";

/**
 * The files the draft mentions, as chips above the input (read from the markers in the text, so
 * they follow edits, undo, dictation and drafts). Removing a chip removes its marker.
 */
export function MentionChips() {
  const aui = useAui();
  const text = useAuiState((s) => s.composer.text);
  const mentions = useMemo(() => mentionsIn(text), [text]);
  if (mentions.length === 0) return null;
  return (
    <ul aria-label="Mentioned files" className="flex flex-wrap gap-1.5 px-1">
      {mentions.map((m) => (
        <li key={m.raw} className={CHIP} title={m.sandboxPath}>
          <FileIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
          <span className="truncate font-medium">@{m.name}</span>
          <button
            type="button"
            aria-label={`Remove mention of ${m.name}`}
            className="hover:bg-muted rounded p-0.5"
            onClick={() => aui.composer.setText(withoutMention(text, m.raw))}
          >
            <XIcon aria-hidden className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}
