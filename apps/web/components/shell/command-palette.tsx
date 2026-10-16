"use client";

import { useAuiState } from "@assistant-ui/react";
import { Dialog } from "radix-ui";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { placementOf } from "../../lib/chat/thread-groups";
import type { FileEntry } from "../../lib/files/api";
import { formatShortcut } from "../../lib/shell/commands";
import type { MenuChoice } from "../../lib/shell/menu";
import {
  filterActions,
  filterChoices,
  navigationBindings,
  paletteActions,
  paletteOutcome,
  type PaletteAction,
} from "../../lib/shell/palette";
import { isMacPlatform, matchesShortcut, shortcutOf } from "../../lib/shell/shortcuts";
import { cn } from "../../lib/utils";
import { useOpenConsoles } from "../admin/console-links";
import { useArtifactPanel } from "../chat/artifact-state";
import { useChatSession } from "../chat/kobe-runtime";
import { chatPortalContainer } from "../ui/chat-portal";
import { useBindCommands, useBoundCommands, useWantCommands } from "./command-bindings";
import { useRail } from "./rail-state";
import { usePaletteSearch, type ThreadHit } from "./use-palette-search";
import { useNavigate } from "./use-navigate";

/** One row of the list: what it shows and what picking it does. */
interface Row {
  readonly key: string;
  readonly group: string;
  readonly label: string;
  /** Right-hand text: the shortcut, the folder, "current", or why it can't run. */
  readonly aside?: string | undefined;
  readonly blocker?: string | null | undefined;
  readonly pick: () => void;
}

type Step =
  { readonly kind: "root" } | { readonly kind: "choices"; readonly action: PaletteAction };

const ROOT: Step = { kind: "root" };

function actionRow(a: PaletteAction, mac: boolean, pick: () => void): Row {
  const keys = a.command.shortcut;
  return {
    key: `action:${a.command.id}`,
    group: "Actions",
    label: a.label,
    aside: a.blocker ?? (keys ? formatShortcut(keys, mac) : undefined),
    blocker: a.blocker,
    pick,
  };
}

function choiceRow(action: PaletteAction, c: MenuChoice, pick: () => void): Row {
  return {
    key: `choice:${action.command.id}:${c.key}`,
    group: action.label,
    label: c.label,
    aside: c.current === true ? "current" : undefined,
    pick,
  };
}

const threadRow = (hit: ThreadHit, pick: () => void): Row => ({
  key: `thread:${hit.threadId}`,
  group: "Threads",
  label: hit.title,
  aside: hit.archived ? "Archived" : undefined,
  pick,
});

const folderOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/"))) || "/";

const fileRow = (entry: FileEntry, pick: () => void): Row => ({
  key: `file:${entry.path}`,
  group: "Files",
  label: entry.name,
  aside: folderOf(entry.path),
  pick,
});

/** The option's accessible name: what it is, where or its key, and why it can't run. */
function optionName(row: Row): string {
  if (row.blocker) return `${row.label}, unavailable: ${row.blocker}`;
  return row.aside ? `${row.label}, ${row.aside}` : row.label;
}

/** Consecutive rows of one group, in order. */
function groupsOf(rows: readonly Row[]) {
  return rows.reduce<{ readonly name: string; readonly rows: readonly Row[] }[]>((acc, row) => {
    const last = acc.at(-1);
    return last?.name === row.group
      ? [...acc.slice(0, -1), { name: last.name, rows: [...last.rows, row] }]
      : [...acc, { name: row.group, rows: [row] }];
  }, []);
}

interface BodyProps {
  /** Closes the palette, then runs `run` once the focus is back where it was. */
  readonly onRun: (run: () => void) => void;
  readonly onOpenThread: (threadId: string) => void;
  readonly step: Step;
  readonly setStep: (step: Step) => void;
  readonly onClose: () => void;
}

/** The rows for the current step and query. */
function useRows(
  { onRun, onOpenThread, step, setStep }: BodyProps,
  query: string,
  say: (text: string) => void,
) {
  const bound = useBoundCommands();
  const navigate = useNavigate();
  const consoles = useOpenConsoles();
  const custom = useAuiState((s) => s.threadListItem.custom);
  const readOnly = placementOf(custom).shared;
  const panel = useArtifactPanel();
  const rail = useRail();
  const session = useChatSession();
  const search = usePaletteSearch(session, step.kind === "root" ? query : "");
  const mac = isMacPlatform();
  const go = useRef(navigate);
  useEffect(() => {
    go.current = navigate;
  });
  const actions = useMemo(
    () =>
      paletteActions(
        { ...navigationBindings((href) => go.current(href)), ...bound },
        { readOnly, consoles },
      ),
    [bound, readOnly, consoles],
  );
  if (step.kind === "choices") {
    const live = actions.find((a) => a.command.id === step.action.command.id) ?? step.action;
    const choices = filterChoices(live.binding.choices ?? [], query);
    return { rows: choices.map((c) => choiceRow(live, c, () => onRun(c.onSelect))), search };
  }
  const pickAction = (a: PaletteAction) => () => {
    const out = paletteOutcome(a);
    if (out.kind === "run") onRun(out.run);
    else if (out.kind === "choose") setStep({ kind: "choices", action: out.action });
    else say(out.reason);
  };
  const openFile = (path: string) => () => {
    if (rail?.drawer) rail.closeDrawer();
    panel?.openFile(path);
  };
  const rows = [
    ...filterActions(actions, query).map((a) => actionRow(a, mac, pickAction(a))),
    ...search.threads.map((t) => threadRow(t, () => onRun(() => onOpenThread(t.threadId)))),
    ...(panel ? search.files.map((f) => fileRow(f, () => onRun(openFile(f.path)))) : []),
  ];
  return { rows, search };
}

function PaletteBody(props: BodyProps) {
  const { step, setStep, onClose } = props;
  const [query, setQuery] = useState("");
  const [said, setSaid] = useState({ text: "", n: 0 });
  const say = (text: string) => setSaid((s) => ({ text, n: s.n + 1 }));
  const { rows, search } = useRows(props, query, say);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  // A new step (an action's choices, or back) keeps the focus in the field.
  useEffect(() => input.current?.focus(), []);
  const listId = useId();
  const optionId = (i: number) => `${listId}-option-${i}`;
  const [seen, setSeen] = useState({ query, step, count: rows.length });
  if (seen.query !== query || seen.step !== step || seen.count !== rows.length) {
    setSeen({ query, step, count: rows.length });
    setActive(0);
  }
  const at = rows.length === 0 ? -1 : Math.min(active, rows.length - 1);
  useEffect(() => {
    if (at >= 0) document.getElementById(optionId(at))?.scrollIntoView?.({ block: "nearest" });
  });

  const back = () => {
    setStep(ROOT);
    setQuery("");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (matchesShortcut(shortcutOf("command-palette"), e, isMacPlatform())) {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length === 0) return;
      const by = e.key === "ArrowDown" ? 1 : -1;
      setActive((Math.max(at, 0) + by + rows.length) % rows.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      rows[at]?.pick();
    } else if (e.key === "Backspace" && query === "" && step.kind === "choices") {
      e.preventDefault();
      back();
    }
  };

  const placeholder =
    step.kind === "choices"
      ? `${step.action.label}: choose ${step.action.command.arg ?? "one"}`
      : "Search actions, threads and files";
  let index = -1;
  return (
    <>
      <input
        ref={input}
        role="combobox"
        aria-label={placeholder}
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={at >= 0 ? optionId(at) : undefined}
        autoComplete="off"
        spellCheck={false}
        maxLength={256}
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        className="border-b bg-transparent px-4 py-3 text-base outline-none"
      />
      <div
        id={listId}
        role="listbox"
        aria-label={step.kind === "choices" ? step.action.label : "Results"}
        className="max-h-[min(24rem,60vh)] overflow-y-auto p-1"
      >
        {groupsOf(rows).map((g) => (
          <div key={g.name} role="group" aria-label={g.name}>
            <div
              role="presentation"
              className="text-muted-foreground px-3 pt-2 pb-1 text-xs font-medium"
            >
              {g.name}
            </div>
            {g.rows.map((row) => {
              index += 1;
              const i = index;
              return (
                <div
                  key={row.key}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === at}
                  aria-disabled={row.blocker ? true : undefined}
                  aria-label={optionName(row)}
                  data-kobe-palette-option={row.key}
                  // The input keeps the focus on a click.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => i !== at && setActive(i)}
                  onClick={row.pick}
                  className={cn(
                    "flex min-w-0 cursor-default items-baseline gap-3 rounded-md px-3 py-1.5 text-sm",
                    i === at && "bg-muted",
                    row.blocker && "opacity-60",
                  )}
                >
                  <span className="truncate">{row.label}</span>
                  {row.aside && (
                    <span className="text-muted-foreground ms-auto shrink-0 truncate text-xs">
                      {row.aside}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <p className="text-muted-foreground m-0 border-t px-4 py-2 text-xs" role="status">
        {said.text ||
          (search.loading
            ? "Searching threads and files…"
            : (search.error ??
              (rows.length === 0
                ? "Nothing matches."
                : query.trim() === "" && step.kind === "root"
                  ? "Type to search threads and files too."
                  : "")))}
        {said.n % 2 === 1 ? "\u00a0" : ""}
      </p>
    </>
  );
}

/**
 * The command palette (CE23, KOBE-225): Ctrl/Cmd+K opens a modal dialog with a combobox that
 * searches the registry's actions, thread titles and workspace file names in one grouped list.
 * Enter runs an action through its live binding (the button's own handler; one that can't run is
 * listed with its reason and does nothing), opens a thread, or opens a file in the artifact
 * column. An action with choices lists them next (Backspace or Escape goes back). The dialog traps
 * the focus and gives it back on close, before the picked action runs, so an action that moves the
 * focus (a dialog, the edit box) keeps it.
 */
export function CommandPalette({
  onOpenThread,
}: {
  readonly onOpenThread: (threadId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>(ROOT);
  const before = useRef<Element | null>(null);
  const pending = useRef<(() => void) | null>(null);
  useWantCommands(open);
  useBindCommands({
    "command-palette": {
      onSelect: () => {
        before.current = document.activeElement;
        setStep(ROOT);
        setOpen(true);
      },
    },
  });
  const onRun = (run: () => void) => {
    pending.current = run;
    setOpen(false);
  };
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal container={chatPortalContainer()}>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" data-kobe-portal />
        <Dialog.Content
          aria-describedby={undefined}
          data-kobe-portal
          data-kobe-palette
          className="bg-background text-foreground fixed top-[15vh] left-1/2 z-50 flex w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-lg border shadow-lg"
          onEscapeKeyDown={(e) => {
            if (step.kind === "root") return;
            e.preventDefault();
            setStep(ROOT);
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            const back = before.current;
            before.current = null;
            if (back instanceof HTMLElement && back.isConnected) back.focus();
            const run = pending.current;
            pending.current = null;
            run?.();
          }}
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <PaletteBody
            key={step.kind === "root" ? "root" : step.action.command.id}
            step={step}
            setStep={setStep}
            onRun={onRun}
            onOpenThread={onOpenThread}
            onClose={() => setOpen(false)}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
