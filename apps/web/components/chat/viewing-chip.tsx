"use client";

import { EyeIcon, XIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import { fileName } from "../../lib/files/preview";
import { useChatSession } from "./kobe-runtime";

/**
 * "Viewing <file>" on the composer (KOBE-463, FE7): the workspace file open in the artifact
 * column, sent with each message as `viewing` so the agent knows what the member is looking at.
 * × stops sending it until another file is viewed.
 */
export function ViewingChip() {
  const viewing = useChatSession().viewing;
  const path = useSyncExternalStore(viewing.subscribe, viewing.current, () => undefined);
  if (path === undefined) return null;
  const name = fileName(path);
  return (
    <div className="px-2">
      <span
        data-kobe-viewing-chip={path}
        title={path}
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs"
      >
        <EyeIcon aria-hidden className="size-3 shrink-0" />
        <span className="truncate">Viewing {name}</span>
        <button
          type="button"
          aria-label={`Don't send ${name} with the message`}
          className="rounded-full p-0"
          onClick={() => viewing.dismiss()}
        >
          <XIcon aria-hidden className="size-3" />
        </button>
      </span>
    </div>
  );
}
