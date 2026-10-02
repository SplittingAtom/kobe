import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ConsoleRoute } from "../../../components/admin/console-route";
import "../admin-global.css";

export const metadata: Metadata = { title: "Team console · Kobe" };

export default function TeamConsoleLayout({ children }: { readonly children: ReactNode }) {
  return <ConsoleRoute kind="team">{children}</ConsoleRoute>;
}
