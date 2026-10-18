"use client";

import { ChevronRightIcon } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useStoredPreference, type LayoutPreferences } from "../../lib/shell/preferences";
import { cn } from "../../lib/utils";
import { IconAction } from "../shell/icon-action";

/**
 * The Detail toggle (CE12, KOBE-208): every reasoning block and tool card is collapsed by default;
 * Mod+Shift+D and the palette open or close them all at once, stored per user (A6). Each answer
 * has its own toggle beside Fork (KOBE-418, `AnswerDetailScope`) for its blocks alone. A card
 * opened or closed by hand keeps that until a toggle over it changes again.
 */
export interface DetailApi {
  readonly expanded: boolean;
  /** Changes on every toggle over a block: cards drop what was opened or closed by hand before. */
  readonly generation: string;
  toggle(): void;
}

const DetailContext = createContext<DetailApi>({
  expanded: false,
  generation: "0",
  toggle: () => {},
});

export function DetailProvider({
  children,
  preferences = null,
  onSave,
}: {
  readonly children: ReactNode;
  /** The member's stored layout (null while it loads). */
  readonly preferences?: LayoutPreferences | null;
  readonly onSave?: ((change: LayoutPreferences) => void) | undefined;
}) {
  const stored = useStoredPreference<boolean>({
    initial: false,
    ready: preferences !== null,
    resolve: () => preferences?.detailExpanded ?? null,
    save: onSave && ((detailExpanded) => onSave({ detailExpanded })),
  });
  const [generation, setGeneration] = useState(0);
  const { value, commit, current } = stored;
  const toggle = useCallback(() => {
    commit(!current());
    setGeneration((g) => g + 1);
  }, [commit, current]);
  const api = useMemo(
    () => ({ expanded: value, generation: String(generation), toggle }),
    [value, generation, toggle],
  );
  return <DetailContext.Provider value={api}>{children}</DetailContext.Provider>;
}

/** An answer's own choice, valid while the conversation-wide toggle hasn't changed since. */
interface AnswerChoice {
  readonly open: boolean;
  readonly over: string;
  readonly seq: number;
}

/**
 * One answer's Detail (KOBE-418): its toggle opens or closes that answer's reasoning blocks and
 * tool cards only. The conversation-wide toggle (Mod+Shift+D, the palette) wins again whenever it
 * changes, as it does over blocks set by hand.
 */
export function AnswerDetailScope({ children }: { readonly children: ReactNode }) {
  const outer = useContext(DetailContext);
  const [choice, setChoice] = useState<AnswerChoice | null>(null);
  const live = choice !== null && choice.over === outer.generation ? choice : null;
  const expanded = live ? live.open : outer.expanded;
  const generation = live ? `${outer.generation}.${live.seq}` : outer.generation;
  const toggle = useCallback(
    () => setChoice((c) => ({ open: !expanded, over: outer.generation, seq: (c?.seq ?? 0) + 1 })),
    [expanded, outer.generation],
  );
  const api = useMemo(() => ({ expanded, generation, toggle }), [expanded, generation, toggle]);
  return <DetailContext.Provider value={api}>{children}</DetailContext.Provider>;
}

/** The conversation's Detail state and its toggle (its shortcut and the palette, KOBE-225). */
export function useDetail(): DetailApi {
  return useContext(DetailContext);
}

/** An answer's Show details, beside Fork (KOBE-418): pressed while its blocks are open. */
export function AnswerDetailToggle() {
  const { expanded, toggle } = useContext(DetailContext);
  return <IconAction command="answer-detail" size="sm" aria-pressed={expanded} onClick={toggle} />;
}

/** A block's open state: the Detail toggle's, unless opened or closed by hand since it changed. */
export function useDisclosure(): { readonly open: boolean; setOpen(next: boolean): void } {
  const { expanded, generation } = useContext(DetailContext);
  const [own, setOwn] = useState<{ readonly open: boolean; readonly generation: string } | null>(
    null,
  );
  const open = own !== null && own.generation === generation ? own.open : expanded;
  const setOpen = useCallback((next: boolean) => setOwn({ open: next, generation }), [generation]);
  return { open, setOpen };
}

/**
 * A collapsible block: the header is a button naming what is inside; the body stays mounted
 * (`hidden` while closed) so its state and any fetched content survive closing it.
 */
export function Disclosure({
  open,
  onOpenChange,
  summary,
  children,
  className,
  headerClassName,
  bodyClassName,
}: {
  readonly open: boolean;
  onOpenChange(next: boolean): void;
  readonly summary: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly headerClassName?: string;
  readonly bodyClassName?: string;
}) {
  const id = useId();
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => onOpenChange(!open)}
        className={cn(
          "hover:bg-muted/50 hover:text-foreground flex w-full min-w-0 items-center gap-1.5 rounded-md border-0 bg-transparent px-2 py-1 text-start",
          headerClassName,
        )}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        {summary}
      </button>
      <div id={id} hidden={!open} className={bodyClassName}>
        {children}
      </div>
    </div>
  );
}
