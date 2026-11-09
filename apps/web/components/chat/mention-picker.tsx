"use client";

import {
  ComposerPrimitive,
  useAuiState,
  type TriggerAdapter,
  type TriggerItem,
} from "@assistant-ui/react";
import { FileIcon } from "lucide-react";
import { useEffect, useMemo, useState, type RefObject } from "react";
import type { FilesApi } from "../../lib/files/api";
import {
  fileItem,
  MENTION_TRIGGER,
  mentionable,
  mentionFormatter,
  mentionQueryAt,
} from "../../lib/chat/mentions";
import { useChatSession } from "./kobe-runtime";

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
          // Names with invisible characters are never offered (the server leaves them out too).
          const items = res.ok ? res.data.entries.filter(mentionable).map(fileItem) : [];
          setFound({ query, items });
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
  draft,
  input,
}: {
  /** The composer draft the picks belong to (thread id, or the new-thread draft). */
  readonly draft: string;
  readonly input: RefObject<HTMLTextAreaElement | null>;
}) {
  const session = useChatSession();
  const { found, loading } = useMentionSearch(session.files, input);
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
      <ComposerPrimitive.TriggerPopover.Directive
        formatter={mentionFormatter}
        onInserted={(item) => session.mentions.add(draft, item.id)}
      />
      <ComposerPrimitive.TriggerPopoverItems aria-label="Files">
        {(list) =>
          list.map((item, index) => (
            <ComposerPrimitive.TriggerPopoverItem
              key={item.id}
              item={item}
              index={index}
              // The input keeps the focus on a click pick (the option unmounts).
              onMouseDown={(e) => e.preventDefault()}
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
