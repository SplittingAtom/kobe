import type { Metadata } from "next";
import type { ReactNode } from "react";
import { MyAgentsShell } from "../../components/me/my-agents-shell";
import "../admin/admin-global.css";

export const metadata: Metadata = { title: "Agents" };

/** The Agents page and the personal agent editor (KOBE-569): the My area's frame. */
export default function AgentsLayout({ children }: { readonly children: ReactNode }) {
  return <MyAgentsShell area="Agents">{children}</MyAgentsShell>;
}
