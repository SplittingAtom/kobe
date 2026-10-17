import type { ReactNode } from "react";
import "./admin-global.css";

/**
 * Every /admin page (the landing, the Site and Team consoles) loads the console stylesheet:
 * Tailwind's theme and utilities, scoped base rules, no preflight (KOBE-294).
 */
export default function AdminLayout({ children }: { readonly children: ReactNode }) {
  return children;
}
