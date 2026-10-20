"use client";

import { createContext, useContext, type ReactNode } from "react";
import { cn } from "../../../lib/utils";

/**
 * In a panel over the workspace (KOBE-424, KOBE-452), a single My area page sits under the panel's
 * own heading (the page's name): the page's title is left out there; its description and actions
 * stay.
 *
 * A client module of its own so `PageHeader` stays usable from Server Components: only this
 * part reads the context.
 */
export const EmbeddedPage = createContext(false);

/** A console page's title (the page's only h1) and description, the title left out when embedded. */
export function PageHeaderText({
  title,
  description,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
}) {
  const embedded = useContext(EmbeddedPage);
  return (
    <>
      {!embedded && <h1 className="m-0 text-3xl leading-tight font-bold">{title}</h1>}
      {description && (
        <p className={cn("m-0 text-console-muted", !embedded && "mt-2")}>{description}</p>
      )}
    </>
  );
}

/**
 * Inside a panel over the workspace (KOBE-452, components/shell/workspace-panel.tsx): the console
 * and My area shells drop the brand that leads back to the chat (`ConsoleLayout`'s `panel`).
 */
export const InPanel = createContext(false);

export function useInPanel(): boolean {
  return useContext(InPanel);
}
