"use client";

import { createContext, useContext, type ReactNode } from "react";
import { cn } from "../../../lib/utils";

/**
 * Embedded beside the thread (CE4, KOBE-424), a My area page sits under its panel's own heading
 * (the area's name): the page's title is left out there; its description and actions stay.
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
