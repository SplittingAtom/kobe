import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ConsoleRoute } from "../../../components/admin/console-route";
import "../admin-global.css";

export const metadata: Metadata = { title: "Install console · Kobe" };

export default function InstallConsoleLayout({ children }: { readonly children: ReactNode }) {
  return <ConsoleRoute kind="install">{children}</ConsoleRoute>;
}
