"use client";

import { Tabs as RadixTabs } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../../lib/utils";
import { FOCUS_RING } from "./focus";

/**
 * Tabs (KOBE-321): Radix Tabs (a `tablist` named by `label`, arrow keys move between tabs and
 * select them, Home and End jump), styled on the console palette. The selected tab has an accent
 * underline and is announced as selected; each panel is named by its tab.
 */
export function Tabs(props: ComponentProps<typeof RadixTabs.Root>) {
  return <RadixTabs.Root data-slot="console-tabs" {...props} />;
}

export function TabsList({
  label,
  className,
  ...props
}: Omit<ComponentProps<typeof RadixTabs.List>, "aria-label"> & { readonly label: string }) {
  return (
    <RadixTabs.List
      aria-label={label}
      className={cn(
        "mb-4 flex flex-wrap gap-1 border-0 border-b border-solid border-console-border",
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof RadixTabs.Trigger>) {
  return (
    <RadixTabs.Trigger
      className={cn(
        "-mb-px cursor-pointer border-0 border-b-2 border-solid border-transparent bg-transparent px-3 py-2 text-base text-console-muted",
        "hover:text-console-fg data-[state=active]:border-console-accent data-[state=active]:font-semibold data-[state=active]:text-console-fg",
        FOCUS_RING,
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof RadixTabs.Content>) {
  return (
    <RadixTabs.Content className={cn("focus:outline-none", FOCUS_RING, className)} {...props} />
  );
}
