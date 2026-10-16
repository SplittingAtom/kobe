"use client";

import {
  ComposerPrimitive,
  unstable_useTriggerPopoverRootContext as useTriggerRoot,
  useAui,
  useAuiState,
  type TriggerAdapter,
  type TriggerItem,
} from "@assistant-ui/react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { useContext, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  SLASH_ARGUMENT,
  SLASH_COMMAND,
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

/** The `/` being typed (null when none), read from the composer text and the input's caret. */
function useSlashQuery(input: RefObject<HTMLTextAreaElement | null>): SlashQuery | null {
  const text = useAuiState((s) => s.composer.text);
  const [query, setQuery] = useState<SlashQuery | null>(null);
  useEffect(() => {
    setQuery(slashQueryAt(text, input.current?.selectionStart ?? text.length));
  }, [text, input]);
  return query;
}

/**
 * Navigation leaves the thread the way the bar's links do: client-side (the draft, its
 * attachments and a live run's stream stay in memory). Outside Next's app router (tests), a load.
 */
function useNavigate(): (href: string) => void {
  const router = useContext(AppRouterContext);
  return (href) => (router ? router.push(href) : window.location.assign(href));
}

/**
 * Enter or Tab on a bare `/` picks nothing until the member moves through the list: the first
 * entry is only highlighted, never chosen by accident. Runs before the popover's own keys.
 */
function useBareSlashGuard(input: RefObject<HTMLTextAreaElement | null>, text: string) {
  const moved = useRef(false);
  useEffect(() => {
    moved.current = false;
  }, [text]);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") moved.current = true;
      const pick = (e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.isComposing;
      const open = el.getAttribute("aria-expanded") === "true";
      if (pick && open && el.value.trim() === SLASH_TRIGGER && !moved.current) e.preventDefault();
    };
    el.addEventListener("keydown", onKeyDown);
    return () => el.removeEventListener("keydown", onKeyDown);
  }, [input]);
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** The option's accessible name: the word, its argument, what it does, and why it can't run. */
function optionName(item: TriggerItem): string {
  const arg = str(item.metadata?.["arg"]);
  const blocker = str(item.metadata?.["blocker"]);
  if (item.type !== SLASH_COMMAND && item.type !== SLASH_ARGUMENT) return item.label;
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

/** The same items (by what they show) keep their identity, so the highlight stays put. */
function useStableItems(items: readonly TriggerItem[]): readonly TriggerItem[] {
  const key = JSON.stringify(items);
  return useMemo(() => items, [key]);
}

/**
 * The `/` actions menu (CE22, KOBE-224) on assistant-ui's trigger popover, beside the `@` picker
 * under the composer's `TriggerPopoverRoot`. It opens only when `/` starts the composer and lists
 * every registry command with a `/` word; each runs its live binding (`useBindCommands`), so a
 * pick runs the button's own handler. One that can't run here is listed, marked unavailable with
 * the reason, and picking it keeps the text and sends nothing. The input is the combobox: arrows
 * move, Enter or Tab picks (an action that takes an argument completes to `/word ` and lists its
 * choices; a bare `/` picks nothing until the list is moved through), Escape closes and keeps the
 * text. A pick removes the `/` text, so nothing of it reaches the prompt; only a word no action
 * has lists nothing, so Enter sends it as a message.
 */
export function SlashMenu({ input }: { readonly input: RefObject<HTMLTextAreaElement | null> }) {
  const aui = useAui();
  const root = useTriggerRoot();
  const bound = useBoundCommands();
  const navigate = useNavigate();
  const text = useAuiState((s) => s.composer.text);
  const query = useSlashQuery(input);
  useWantCommands(query !== null);
  useBareSlashGuard(input, text);
  // Spoken outcomes; the counter makes a repeated reason a change screen readers announce.
  const [said, setSaid] = useState({ text: "", n: 0 });
  // The text as typed, before a pick removes it: a refused pick puts it back.
  const typed = useRef(text);
  useEffect(() => {
    typed.current = text;
  }, [text]);
  const go = useRef(navigate);
  useEffect(() => {
    go.current = navigate;
  });
  const entries = useMemo(
    // Readers never get the composer (KOBE-221 banner), so the menu is never a reader's.
    () =>
      slashEntries({ ...hrefBindings((href) => go.current(href)), ...bound }, { readOnly: false }),
    [bound],
  );
  const items = useStableItems(
    useMemo(() => (query === null ? [] : slashItems(query, entries)), [query, entries]),
  );
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
  const say = (value: string) => setSaid((s) => ({ text: value, n: s.n + 1 }));
  const onExecute = (item: TriggerItem) => {
    const out = slashOutcome(item, entries);
    if (out.kind === "complete") return write(out.text);
    if (out.kind === "blocked") {
      say(out.reason);
      return write(typed.current);
    }
    // The pick removed the command; drop the whitespace that stood before it too.
    if (aui.composer.getState().text.trim() === "") aui.composer.setText("");
    say("");
    out.run();
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
        <ComposerPrimitive.TriggerPopoverItems
          aria-label={query?.arg === undefined ? "Commands" : "Choices"}
        >
          {(list) =>
            list.map((item, index) => {
              const blocker = str(item.metadata?.["blocker"]);
              const arg = str(item.metadata?.["arg"]);
              const plain = item.type === SLASH_ARGUMENT || blocker === item.label;
              return (
                <ComposerPrimitive.TriggerPopoverItem
                  key={item.id}
                  item={item}
                  index={index}
                  aria-label={optionName(item)}
                  aria-disabled={blocker !== undefined || undefined}
                  // The input keeps the focus on a click pick (the option unmounts).
                  onMouseDown={(e) => e.preventDefault()}
                  className="data-[highlighted]:bg-muted flex w-full min-w-0 items-baseline gap-2 rounded-lg px-2 py-1.5 text-start text-sm aria-disabled:opacity-60"
                >
                  <span className={plain ? "truncate font-medium" : "font-mono font-medium"}>
                    {item.label}
                  </span>
                  {arg !== undefined && (
                    <span className="text-muted-foreground font-mono text-xs">‹{arg}›</span>
                  )}
                  {!plain && (
                    <span className="text-muted-foreground ms-auto truncate text-xs">
                      {blocker ?? item.description}
                    </span>
                  )}
                  {item.type === SLASH_ARGUMENT && item.description && (
                    <span className="text-muted-foreground ms-auto truncate text-xs">
                      {item.description}
                    </span>
                  )}
                </ComposerPrimitive.TriggerPopoverItem>
              );
            })
          }
        </ComposerPrimitive.TriggerPopoverItems>
      </ComposerPrimitive.TriggerPopover>
      <span role="status" className="sr-only" data-kobe-slash-status>
        {said.text}
        {said.n % 2 === 1 ? " " : ""}
      </span>
    </>
  );
}
