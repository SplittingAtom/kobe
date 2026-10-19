"use client";

import { AppWindowIcon } from "lucide-react";
import { textReason } from "../../lib/apps/app-results";
import { useKobeExtras } from "../chat/kobe-runtime";
import { isReadOnlyThread } from "../chat/project-bar";
import { INLINE_HEIGHT } from "./app-frame";
import { useThreadApps } from "./thread-apps";
import { AppPlaceholder, LiveApp } from "./tool-card-app";

/**
 * A rail-launched app card in the conversation (KOBE-440, spec MA3, MA11): a header Kobe draws
 * ("You opened _app_ from _connector_"), then the app rendered from the stored result of its
 * opening tool, acting as the viewer (T12), with Expand, lazy loading and the thread's 3 live
 * frames like a tool card's app; or the text card's one-line reason. The model sees only the
 * card's text result, fenced as untrusted data, in its next run.
 */
export function AppCardPart({ data }: { readonly data: { entryId: string; tool: string } }) {
  const apps = useThreadApps();
  const readOnly = isReadOnlyThread(useKobeExtras());
  const view = apps?.byEntry.get(data.entryId);
  const title = view?.app?.title ?? view?.tool ?? data.tool;
  const who = readOnly ? "The owner opened" : "You opened";
  return (
    <section
      className="border-border overflow-hidden rounded-lg border"
      data-kobe-app-card-entry={data.entryId}
      aria-label={`${title} app`}
    >
      <header className="text-muted-foreground flex items-center gap-2 px-3 py-2 text-xs">
        <AppWindowIcon aria-hidden className="size-3.5" />
        <span>
          {who} {title}
          {view ? ` from ${view.connectorName}` : ""}
        </span>
      </header>
      {!apps || !view ? (
        <AppPlaceholder height={INLINE_HEIGHT} label="Loading app" />
      ) : view.view !== "app" ? (
        <p
          className="text-muted-foreground border-t px-3 py-2 text-xs"
          data-kobe-app-text={view.reason}
        >
          {textReason(view)}
        </p>
      ) : (
        <LiveApp apps={apps} view={view} />
      )}
    </section>
  );
}
