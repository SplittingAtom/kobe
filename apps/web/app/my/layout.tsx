import type { Metadata } from "next";
import type { ReactNode } from "react";
import { MyRoute } from "../../components/my/my-route";
import "../admin/admin-global.css";

export const metadata: Metadata = { title: "My area · Kobe" };

export default function MyLayout({ children }: { readonly children: ReactNode }) {
  return <MyRoute>{children}</MyRoute>;
}
