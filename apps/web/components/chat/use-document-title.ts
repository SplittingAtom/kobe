"use client";

import { useEffect } from "react";
import { stripTitlePrefix } from "../../lib/chat/thread-activity";

/**
 * The browser tab's title while a conversation is open (KOBE-589, TT4): the header's text followed
 * by the page's own title (the site name), as "<title> · <site>", keeping the hidden-tab activity
 * prefix (`useTabTitle`, KOBE-301) that may already be on it. The title the
 * page had returns when the conversation closes (`null` leaves the tab alone).
 */
export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    if (title === null) return;
    const before = stripTitlePrefix(document.title);
    const current = document.title;
    const prefix = current.slice(0, current.length - before.length);
    document.title = before === "" ? prefix + title : `${prefix}${title} · ${before}`;
    return () => {
      const now = document.title;
      const nowPrefix = now.slice(0, now.length - stripTitlePrefix(now).length);
      document.title = nowPrefix + before;
    };
  }, [title]);
}
