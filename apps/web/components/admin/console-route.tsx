"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import type { ConsoleKind } from "../../lib/admin/nav/types";
import { ConsoleShell } from "./console-shell";

/** Binds the console shell to the router's current path. */
export function ConsoleRoute({
  kind,
  children,
}: {
  readonly kind: ConsoleKind;
  readonly children: ReactNode;
}) {
  return (
    <ConsoleShell kind={kind} pathname={usePathname() ?? ""}>
      {children}
    </ConsoleShell>
  );
}
