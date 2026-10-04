"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { MyShell } from "./my-shell";

/** Binds the member-area shell to the router's current path. */
export function MyRoute({ children }: { readonly children: ReactNode }) {
  return <MyShell pathname={usePathname() ?? ""}>{children}</MyShell>;
}
