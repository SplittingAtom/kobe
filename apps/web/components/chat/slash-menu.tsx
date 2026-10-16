"use client";

import {
  ComposerPrimitive,
  unstable_useTriggerPopoverRootContext as useTriggerRoot,
  useAui,
  useAuiState,
  type TriggerAdapter,
  type TriggerItem,
} from "@assistant-ui/react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  SLASH_ARGUMENT,
  SLASH_TRIGGER,
  hrefBindings,
  slashEntries,
  slashItems,
  slashMatcher,
  slashOutcome,
  slashQueryAt,
  type SlashEntry,
  type SlashQuery,
} from "../../lib/shell/slash";
import { useBoundCommands, useWantCommands } from "../shell/command-bindings";

/** Navigation commands leave the chat, as their links do. */
const go = (href: string) => window.location.assign(href);

/** The `/` being typed (null when none), read from the composer text and the input's caret. */
function useSlashQuery(input: RefObject<HTMLTextAreaElement | null>): SlashQuery | null {
  const text = useAuiState((s) => s.composer.text);
  const [query, setQuery] = useState<SlashQuery | null>(null);
  useEffect(() => {
    setQuery(slashQueryAt(text, input.current?.selectionStart ?? text.length));
  }, [text, input]);
  return query;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** The option's accessible name: the word, its argument, what it does, and why it can't run. */
function optionName(item: TriggerItem): string {
  const arg = str(item.metadata?.["arg"]);
  const blocker = str(item.metadata?.["blocker"]);
  const head = arg === undefined ? item.label : `${item.label} ${arg}`;
  const parts = [head, item.description, blocker && `unavailable: ${blocker}`];
  return parts.filter((p) => p !== undefined && p !== "").join(", ");
}

/** The list's name: the actions, or the choices of the action being completed. */
function listName(query: SlashQuery | null, entries: readonly SlashEntry[]): string {
  if (query?.arg === undefined) return "Actions";
  const entry = entries.find((e) => e.slash === query.name.toLowerCase());
  return entry?.command.arg ? `${entry.command.arg} for ${SLASH_TRIGGER}${entry.slash}` : "Actions";
}

/**
 * The `/` actions menu (CE22, KOBE-224) on assistant-ui's trigger popover, beside the `@` picker
 * under the composer's `TriggerPopoverRoot`. It opens only when `/` starts the composer and lists
 * the registry commands that have a `/` word and a live binding (`useBindCommands`), so a pick
 * runs the button's own handler; a command that can't run now is listed, marked unavailable with
 * the reason. The input is the combobox: arrows move, Enter or Tab picks (an action that takes an
 * argument completes to `/word ` and lists its choices), Escape closes and keeps the text. A pick
 * removes the `/` text, so nothing of it reaches the prompt; an unknown word lists nothing, so
 * Enter sends the text as a message.
 */
export function SlashMenu({
  input,
  readOnly,
}: {
  readonly input: RefObject<HTMLTextAreaElement | null>;
  /** A reader of a shared thread: only read-only-safe actions. */
  readonly readOnly: boolean;
}) {
  const aui = useAui();
  const root = useTriggerRoot();
  const bound = useBoundCommands();
  const text = useAuiState((s) => s.composer.text);
  const query = useSlashQuery(input);
  useWantCommands(query !== null);
  const [said, setSaid] = useState("");
  // The text as typed, before a pick removes it: a refused pick puts it back.
  const typed = useRef(text);
  useEffect(() => {
    typed.current = text;
  }, [text]);
  const entries = useMemo(
    () => slashEntries({ ...hrefBindings(go), ...bound }, { readOnly }),
    [bound, readOnly],
  );
  const items = useMemo(() => (query === null ? [] : slashItems(query, entries)), [query, entries]);
  const adapter = useMemo<TriggerAdapter | undefined>(
    () =>
      items.length === 0
        ? undefined
        : { categories: () => [], categoryItems: () => [], search: () => items },
    [items],
  );

  /** Writes `value` and keeps the menu reading it from its end (completion, refusal). */
  const write = (value: string) => {
    aui.composer.setText(value);
    root.getTriggers().get(SLASH_TRIGGER)?.resource.setCursorPosition(value.length);
  };
  const onExecute = (item: TriggerItem) => {
    const out = slashOutcome(item, entries);
    if (out.kind === "complete") return write(out.text);
    if (out.kind === "blocked") {
      setSaid(out.reason);
      return write(typed.current);
    }
    // The pick removed the command; drop the whitespace that stood before it too.
    if (aui.composer.getState().text.trim() === "") aui.composer.setText("");
    setSaid("");
    if (out.kind === "run") out.run();
  };

  const name = listName(query, entries);
  return (
    <>
      <ComposerPrimitive.TriggerPopover
        char={SLASH_TRIGGER}
        matcher={slashMatcher}
        adapter={adapter}
        aria-label={name}
        className="bg-popover text-popover-foreground border-foreground/10 absolute bottom-full left-0 z-20 mb-2 max-h-72 w-full overflow-y-auto rounded-xl border p-1 shadow-lg"
      >
        <ComposerPrimitive.TriggerPopover.Action onExecute={onExecute} removeOnExecute />
        <ComposerPrimitive.TriggerPopoverItems aria-label={name}>
          {(list) =>
            list.map((item, index) => {
              const blocker = str(item.metadata?.["blocker"]);
              const arg = str(item.metadata?.["arg"]);
              return (
                <ComposerPrimitive.TriggerPopoverItem
                  key={item.id}
                  item={item}
                  index={index}
                  aria-label={optionName(item)}
                  aria-disabled={blocker !== undefined || undefined}
                  className="data-[highlighted]:bg-muted flex w-full min-w-0 items-baseline gap-2 rounded-lg px-2 py-1.5 text-start text-sm aria-disabled:opacity-60"
                >
                  <span
                    className={
                      item.type === SLASH_ARGUMENT
                        ? "truncate font-medium"
                        : "font-mono font-medium"
                    }
                  >
                    {item.label}
                  </span>
                  {arg !== undefined && (
                    <span className="text-muted-foreground font-mono text-xs">‹{arg}›</span>
                  )}
                  <span className="text-muted-foreground ms-auto truncate text-xs">
                    {blocker ?? item.description}
                  </span>
                </ComposerPrimitive.TriggerPopoverItem>
              );
            })
          }
        </ComposerPrimitive.TriggerPopoverItems>
      </ComposerPrimitive.TriggerPopover>
      <span role="status" className="sr-only" data-kobe-slash-status>
        {said}
      </span>
    </>
  );
}
