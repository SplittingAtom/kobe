"use client";

/**
 * The file editor's one toolbar (KOBE-615): every control of an open file in one row at the top
 * (Save, Save As, the Rendered/Raw switch, and for runnable files Run, Interrupt and Start or
 * Restart with the kernel's state). An action marked `overflow` folds into a More menu when the
 * toolbar is narrow (a container query on the toolbar itself, so it follows the artifact column's
 * width live, whatever the window); everything else stays in the row. A disabled action says why
 * in its tooltip (`title`, also its accessible description).
 */
import { MoreHorizontalIcon, type LucideIcon } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useState, type ReactNode } from "react";
import { chatPortalContainer } from "../ui/chat-portal";
import { cn } from "../../lib/utils";
import type { TextMode } from "./text-modes";

export interface ToolbarAction {
  /** Stable key; also `data-kobe-action` on the button. */
  readonly id: string;
  /** The name (the More menu's item, and the button's text unless `text` says otherwise). */
  readonly label: string;
  /** The button's text (and so its name) when it differs, a busy "Saving…". */
  readonly text?: string | undefined;
  readonly icon?: LucideIcon | undefined;
  onSelect(): void;
  readonly disabled?: boolean | undefined;
  /** Why it is disabled (tooltip and description). */
  readonly reason?: string | undefined;
  /** Folds into the More menu at narrow widths. */
  readonly overflow?: boolean | undefined;
  readonly busy?: boolean | undefined;
}

export const TOOL_BUTTON =
  "hover:bg-muted inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs disabled:opacity-50";
/** Folded (hidden) below this toolbar width, and listed in the More menu instead. */
const FOLDS = "hidden @min-[34rem]/toolbar:inline-flex";
const MORE = "@min-[34rem]/toolbar:hidden";
const MENU = "bg-background text-foreground z-50 min-w-40 rounded-lg border p-1 shadow-md";
const MENU_ITEM =
  "hover:bg-muted focus:bg-muted flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50";

/** A disabled action's reason is its `title`: its tooltip, and its accessible description. */
function ActionButton({ action }: { readonly action: ToolbarAction }) {
  const Icon = action.icon;
  return (
    <button
      type="button"
      data-kobe-action={action.id}
      className={cn(TOOL_BUTTON, action.overflow && FOLDS)}
      disabled={action.disabled}
      aria-busy={action.busy || undefined}
      title={action.disabled ? action.reason : undefined}
      onClick={action.onSelect}
    >
      {Icon && <Icon aria-hidden className="size-3.5 shrink-0" />}
      {action.text ?? action.label}
    </button>
  );
}

function MoreMenu({ actions }: { readonly actions: readonly ToolbarAction[] }) {
  const [open, setOpen] = useState(false);
  if (actions.length === 0) return null;
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="More file actions"
          title="More file actions"
          className={cn(TOOL_BUTTON, "px-1.5", MORE)}
        >
          <MoreHorizontalIcon aria-hidden className="size-3.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={chatPortalContainer()}>
        <DropdownMenu.Content data-kobe-portal align="end" sideOffset={4} className={MENU}>
          {actions.map((action) => {
            const Icon = action.icon;
            return (
              <DropdownMenu.Item
                key={action.id}
                className={MENU_ITEM}
                disabled={action.disabled}
                title={action.disabled ? action.reason : undefined}
                onSelect={action.onSelect}
              >
                {Icon && <Icon aria-hidden className="size-4 shrink-0" />}
                {action.label}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * The toolbar: `leading` (the mode switch), the actions, then `status` (the kernel's state) and
 * the More menu at the end.
 */
export function EditorToolbar({
  label,
  leading,
  actions,
  status,
}: {
  /** The toolbar's accessible name. */
  readonly label: string;
  readonly leading?: ReactNode;
  readonly actions: readonly ToolbarAction[];
  readonly status?: ReactNode;
}) {
  return (
    <div className="@container/toolbar w-full min-w-0 shrink-0">
      <div
        role="toolbar"
        aria-label={label}
        data-kobe-editor-toolbar=""
        className="flex min-w-0 flex-wrap items-center gap-1 border-b pb-1.5"
      >
        {leading}
        {actions.map((action) => (
          <ActionButton key={action.id} action={action} />
        ))}
        <span className="ms-auto flex min-w-0 items-center gap-1">
          {status}
          <MoreMenu actions={actions.filter((a) => a.overflow)} />
        </span>
      </div>
    </div>
  );
}

/**
 * Rendered or Raw as one switch (`role="switch"`, named Raw: checked shows the raw text). Space
 * and Enter toggle it (a native button); the words on either side are mouse shortcuts.
 */
export function ModeSwitch({
  mode,
  onMode,
}: {
  readonly mode: TextMode;
  onMode(mode: TextMode): void;
}) {
  const raw = mode === "raw";
  const word = (on: boolean) =>
    cn("cursor-pointer text-xs select-none", on ? "font-medium" : "text-muted-foreground");
  return (
    <span className="me-1 inline-flex items-center gap-1.5" data-kobe-mode={mode}>
      <span aria-hidden className={word(!raw)} onClick={() => onMode("rendered")}>
        Rendered
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={raw}
        aria-label="Raw"
        title={raw ? "Show it rendered" : "Show the raw text"}
        className={cn(
          "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border p-0 transition-colors motion-reduce:transition-none",
          raw ? "bg-primary border-primary" : "bg-muted",
        )}
        onClick={() => onMode(raw ? "rendered" : "raw")}
      >
        <span
          aria-hidden
          className={cn(
            "bg-background block size-3 rounded-full shadow transition-transform motion-reduce:transition-none",
            raw ? "translate-x-3" : "translate-x-0.5",
          )}
        />
      </button>
      <span aria-hidden className={word(raw)} onClick={() => onMode("raw")}>
        Raw
      </span>
    </span>
  );
}
