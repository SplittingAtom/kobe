"use client";

import { EllipsisIcon } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useRef, useState } from "react";
import { cn } from "../../../lib/utils";
import { consolePortalContainer } from "../chat-portal";
import { Button } from "./button";

export interface RowMenuItem {
  /** Stable key and `data-action` of the item. */
  readonly id: string;
  readonly label: string;
  /**
   * Runs once the menu has closed, with the ⋯ button (focused again) as the asking control: pass
   * it to `useConfirm()` so the dialog gives focus back to it.
   */
  readonly onSelect: (trigger: HTMLElement | null) => void;
  /** Suspending, removing, revoking: shown in the danger colour. */
  readonly destructive?: boolean;
  readonly disabled?: boolean;
}

const CONTENT =
  "z-50 box-border min-w-44 rounded-lg border border-console-border bg-console-bg p-1 text-console-fg shadow-md";
const ITEM =
  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-console-panel";

/**
 * A table row's actions behind one ⋯ button (KOBE-306), so a dense table keeps its width: the
 * menu button pattern (Radix DropdownMenu: Enter, Space or the arrow keys open it, arrows move,
 * Escape closes and returns focus to the button). `label` names the button for the row ("Actions
 * for Triage"). Portalled into the console root (KOBE-294). Renders nothing without items.
 */
export function RowMenu({
  label,
  items,
  busy = false,
}: {
  readonly label: string;
  readonly items: readonly RowMenuItem[];
  /** One of the row's actions is running: the button shows a spinner and stays closed. */
  readonly busy?: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const pending = useRef<RowMenuItem | null>(null);
  // Controlled, so opening renders this again and the portal finds the console root even when the
  // row first rendered before the root was in the document.
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <Button
          ref={trigger}
          variant="ghost"
          size="sm"
          aria-label={label}
          title={label}
          loading={busy}
          data-slot="console-row-menu"
        >
          {!busy && <EllipsisIcon aria-hidden />}
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={consolePortalContainer()}>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className={CONTENT}
          onCloseAutoFocus={(e) => {
            const item = pending.current;
            if (!item) return;
            pending.current = null;
            e.preventDefault();
            trigger.current?.focus();
            item.onSelect(trigger.current);
          }}
        >
          {items.map((item) => (
            <DropdownMenu.Item
              key={item.id}
              data-action={item.id}
              disabled={item.disabled === true}
              className={cn(ITEM, item.destructive === true && "text-console-danger")}
              onSelect={() => {
                pending.current = item;
              }}
            >
              {item.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
