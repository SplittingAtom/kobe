"use client";

import { ChevronRightIcon } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useEffect, useId, useRef, useState } from "react";
import type { CommandId } from "../../lib/shell/commands";
import { menuItems, type MenuBindings, type MenuItem, type MenuScope } from "../../lib/shell/menu";
import { cn } from "../../lib/utils";
import { IconAction } from "../shell/icon-action";
import { chatPortalContainer } from "./chat-portal";

const CONTENT = "bg-background text-foreground z-50 min-w-44 rounded-lg border p-1 shadow-md";
const ITEM =
  "hover:bg-muted focus:bg-muted data-[state=open]:bg-muted flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none aria-disabled:cursor-not-allowed aria-disabled:opacity-50";
const DESTRUCTIVE = "text-destructive";
const CURRENT = " (current)";

/**
 * Shown on a row's hover or focus (`group/row` on the row), and while its menu is open. Under
 * 768 px, and wherever the pointer is coarse (touch), always.
 */
export const ROW_REVEAL =
  "md:pointer-fine:opacity-0 md:pointer-fine:group-hover/row:opacity-100 md:pointer-fine:group-focus-within/row:opacity-100 md:pointer-fine:data-[state=open]:opacity-100";

function Face({ item }: { readonly item: MenuItem }) {
  const Icon = item.command.icon;
  return (
    <>
      <Icon aria-hidden className="size-4 shrink-0" />
      {item.label}
    </>
  );
}

/** Why the item can't run, for screen readers: referenced while hidden (`aria-describedby`). */
function Reason({ id, reason }: { readonly id: string; readonly reason: string }) {
  return (
    <span id={id} hidden>
      {reason}
    </span>
  );
}

function Entry({
  item,
  onAfterClose,
}: {
  readonly item: MenuItem;
  /** Runs `act` once the menu has closed (its focus trap gone), keeping the focus it moves. */
  readonly onAfterClose: (act: () => void) => void;
}) {
  const reasonId = useId();
  const blocker = item.blocker ?? null;
  const className = cn(ITEM, item.destructive && DESTRUCTIVE);
  if (item.choices && blocker === null) {
    return (
      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger className={className} data-command={item.command.id}>
          <Face item={item} />
          <ChevronRightIcon aria-hidden className="ms-auto size-4" />
        </DropdownMenu.SubTrigger>
        <DropdownMenu.Portal container={chatPortalContainer()}>
          <DropdownMenu.SubContent data-kobe-portal sideOffset={4} className={CONTENT}>
            {item.choices.map((choice) => (
              <DropdownMenu.Item key={choice.key} className={ITEM} onSelect={choice.onSelect}>
                {choice.label}
                {choice.current ? CURRENT : ""}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.SubContent>
        </DropdownMenu.Portal>
      </DropdownMenu.Sub>
    );
  }
  // Unavailable items stay focusable (Radix's `disabled` would skip them), so the reason is heard.
  return (
    <>
      <DropdownMenu.Item
        className={className}
        data-command={item.command.id}
        aria-disabled={blocker !== null || undefined}
        aria-describedby={blocker !== null ? reasonId : undefined}
        title={blocker ?? undefined}
        onSelect={(e) => {
          if (blocker !== null) {
            e.preventDefault();
            return;
          }
          const act = item.onSelect;
          if (act && item.movesFocus) onAfterClose(act);
          else act?.();
        }}
      >
        <Face item={item} />
      </DropdownMenu.Item>
      {blocker !== null && <Reason id={reasonId} reason={blocker} />}
    </>
  );
}

/**
 * A row's ⋯ menu (KOBE-292): the menu button pattern (Radix DropdownMenu: Enter, Space or the
 * arrow keys open it, arrows move, Escape closes and returns focus to the button), listing the
 * commands of `scope` the row binds (`menuItems`), with submenus for choices. Portalled into the
 * chat root and marked `data-kobe-portal`, so the drawer's modal layer counts it as inside and the
 * theme tokens and preflight slice apply in both themes (KOBE-281/282). The thread rows and the
 * file browser share it; KOBE-220's Pin, Archive and Move are bindings on the thread row.
 */
export function ActionMenu({
  trigger,
  label,
  scope,
  bindings,
  onOpenChange,
  className,
  size = "sm",
  tabIndex,
  openSignal = 0,
}: {
  /** The registry's button command (its icon); `label` names the row's object. */
  readonly trigger: CommandId;
  readonly label: string;
  readonly scope: MenuScope;
  readonly bindings: MenuBindings;
  readonly onOpenChange?: ((open: boolean) => void) | undefined;
  readonly className?: string | undefined;
  /** The button's size: `md` is the standard 32 px target (the file rows, KOBE-269). */
  readonly size?: "sm" | "md" | undefined;
  /** -1 inside a composite widget (the Files tree) whose rows own the tab stop. */
  readonly tabIndex?: number | undefined;
  /** Each new value above 0 opens the menu (the tree's Shift+F10 / Menu key, KOBE-304). */
  readonly openSignal?: number | undefined;
}) {
  const items = menuItems(scope, bindings);
  // Controlled, so opening renders this again and the portal finds the chat root even when the
  // row first rendered before the root was in the document.
  const [open, setOpen] = useState(false);
  const afterClose = useRef<(() => void) | null>(null);
  const change = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  useEffect(() => {
    if (openSignal > 0) setOpen(true);
  }, [openSignal]);
  return (
    <DropdownMenu.Root open={open} onOpenChange={change}>
      <DropdownMenu.Trigger asChild>
        <IconAction
          command={trigger}
          label={label}
          size={size}
          className={className}
          {...(tabIndex === undefined ? {} : { tabIndex })}
        />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={chatPortalContainer()}>
        <DropdownMenu.Content
          data-kobe-portal
          align="end"
          sideOffset={4}
          className={CONTENT}
          onCloseAutoFocus={(e) => {
            const act = afterClose.current;
            if (!act) return;
            afterClose.current = null;
            e.preventDefault();
            act();
          }}
        >
          {items.map((item) => (
            <Entry
              key={item.command.id}
              item={item}
              onAfterClose={(act) => {
                afterClose.current = act;
              }}
            />
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
