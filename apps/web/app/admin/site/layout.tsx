import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ConsoleRoute } from "../../../components/admin/console-route";

export const metadata: Metadata = { title: "Site console" };

export default function SiteConsoleLayout({ children }: { readonly children: ReactNode }) {
  return <ConsoleRoute kind="site">{children}</ConsoleRoute>;
}
