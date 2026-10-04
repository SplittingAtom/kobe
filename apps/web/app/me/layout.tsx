import type { Metadata } from "next";
import type { ReactNode } from "react";
import { MyAgentsShell } from "../../components/me/my-agents-shell";
import "../admin/admin-global.css";

export const metadata: Metadata = { title: "My agents · Kobe" };

export default function MyAreaLayout({ children }: { readonly children: ReactNode }) {
  return <MyAgentsShell>{children}</MyAgentsShell>;
}
