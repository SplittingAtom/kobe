"use client";

import Link from "next/link";
import { useSyncExternalStore, type ReactNode } from "react";
import { lastThreadHref } from "../../lib/shell/last-thread";

const subscribe = () => () => undefined;
const onServer = () => "/";

/**
 * The link from a full-page route (console, builder) back to the chat, onto the thread that was
 * open (CE4). The server render and first paint say "/"; the browser then reads the tab's thread.
 */
export function ChatReturnLink({ children }: { readonly children: ReactNode }) {
  const href = useSyncExternalStore(subscribe, lastThreadHref, onServer);
  return <Link href={href}>{children}</Link>;
}
