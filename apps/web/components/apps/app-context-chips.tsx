"use client";

import { BlocksIcon, XIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import { chipSummary } from "../../lib/apps/app-context";
import { useChatSession } from "../chat/kobe-runtime";

/**
 * The composer's MCP Apps context chips (KOBE-439, spec §8, ac-2): "Context from <app>: <one
 * line>", each removable, with the exact JSON one click away. Only what is shown here is sent.
 */
export function AppContextChips({ draft }: { readonly draft: string }) {
  const session = useChatSession();
  const store = session.appContexts;
  const chips = useSyncExternalStore(
    store.subscribe,
    () => store.snapshot(draft),
    () => store.snapshot(draft),
  );
  if (chips.size === 0) return null;
  return (
    <ul
      aria-label="App context sent with your next message"
      className="m-0 flex list-none flex-col gap-1 p-0 px-2"
    >
      {[...chips.values()].map((chip) => (
        <li
          key={chip.appId}
          data-kobe-app-context={chip.appId}
          className="rounded-md border px-2 py-1 text-xs"
        >
          <details>
            <summary className="flex cursor-pointer items-center gap-1.5">
              <BlocksIcon aria-hidden className="size-3 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                Context from {chip.title}: {chipSummary(chip)}
              </span>
              <button
                type="button"
                aria-label={`Remove context from ${chip.title}`}
                onClick={(e) => {
                  e.preventDefault();
                  store.remove(draft, chip.appId);
                }}
              >
                <XIcon aria-hidden className="size-3" />
              </button>
            </summary>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap">
              {JSON.stringify(chip.data, null, 2)}
            </pre>
          </details>
        </li>
      ))}
    </ul>
  );
}
