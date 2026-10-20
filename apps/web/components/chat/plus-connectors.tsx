"use client";

import { CheckIcon, CircleXIcon, PlugIcon } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useCallback, useEffect, useId, useState, useSyncExternalStore } from "react";
import {
  listChatConnectors,
  setThreadConnector,
  type ChatConnector,
} from "../../lib/chat/composer-plus-api";
import { useNavigate } from "../shell/use-navigate";
import { chatPortalContainer } from "../ui/chat-portal";
import { useChatSession } from "./kobe-runtime";
import { PLUS_CONTENT, PLUS_ITEM } from "./plus-menu-styles";

/** What a toggle means before the first message (KOBE-451 review MEDIUM-3). */
export const NOT_STARTED = "Applies to this new conversation once you send its first message.";

type Load =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly list: readonly ChatConnector[] }
  | { readonly status: "error"; readonly message: string };

/** The member's connectors for `threadId` (null: not started), read each time the menu opens. */
function useChatConnectors(threadId: string | null, open: boolean) {
  const session = useChatSession();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setLoad({ status: "loading" });
    void listChatConnectors(session.teamId, threadId).then((res) => {
      if (!alive) return;
      setLoad(
        res.ok
          ? { status: "ready", list: res.data.connectors }
          : { status: "error", message: res.error.message },
      );
    });
    return () => {
      alive = false;
    };
  }, [session.teamId, threadId, open]);
  return [load, setLoad] as const;
}

function Broken({ connector }: { readonly connector: ChatConnector }) {
  const navigate = useNavigate();
  const reasonId = useId();
  const problem = connector.problem;
  if (problem === null) return null;
  const fix = problem.fix;
  return (
    <>
      <DropdownMenu.Item
        className={PLUS_ITEM}
        data-kobe-connector={connector.connectorId}
        data-kobe-connector-problem={problem.code}
        aria-disabled={fix === null || undefined}
        aria-describedby={reasonId}
        onSelect={(e) => {
          if (fix === null) e.preventDefault();
          else navigate(fix.href);
        }}
      >
        <CircleXIcon aria-label="Not working" className="text-destructive size-4 shrink-0" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{connector.name}</span>
          <span id={reasonId} className="text-muted-foreground text-xs whitespace-normal">
            {problem.message}
            {fix !== null && <span className="underline"> {fix.label}</span>}
          </span>
        </span>
      </DropdownMenu.Item>
    </>
  );
}

/**
 * The + menu's Connectors (KOBE-451): the member's MCP servers in this team as the server lists
 * them. A working one is a checkbox for this conversation only (on by default; stored on the
 * server, which refuses a connector the member can't use; before the first message the choice
 * goes with the thread's creation); a broken one shows a red ✕, the
 * server's reason and, where it applies, its fix link, and no toggle.
 */
export function ConnectorsSubmenu({
  threadId,
  open,
}: {
  readonly threadId: string | null;
  readonly open: boolean;
}) {
  const session = useChatSession();
  const [load, setLoad] = useChatConnectors(threadId, open);
  const [error, setError] = useState<string | null>(null);
  // Before the first message the choice is the draft's; the thread's creation sends it.
  const draftOff = useSyncExternalStore(
    session.draftConnectors.subscribe,
    session.draftConnectors.snapshot,
    session.draftConnectors.snapshot,
  );
  const enabledOf = (c: ChatConnector) =>
    threadId === null ? !draftOff.has(c.connectorId) : c.enabled;
  const toggle = useCallback(
    async (c: ChatConnector) => {
      if (threadId === null) {
        session.draftConnectors.set(c.connectorId, draftOff.has(c.connectorId));
        return;
      }
      setError(null);
      const res = await setThreadConnector(session.teamId, threadId, c.connectorId, !c.enabled);
      if (!res.ok) {
        setError(res.error.message);
        return;
      }
      const next = res.data.connector;
      setLoad((l) =>
        l.status === "ready"
          ? {
              status: "ready",
              list: l.list.map((x) => (x.connectorId === next.connectorId ? next : x)),
            }
          : l,
      );
    },
    [session, threadId, setLoad, draftOff],
  );
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className={PLUS_ITEM} data-kobe-plus="connectors">
        <PlugIcon aria-hidden className="size-4 shrink-0" />
        Connectors
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal container={chatPortalContainer()}>
        <DropdownMenu.SubContent
          data-kobe-portal
          aria-label="Connectors"
          sideOffset={4}
          className={PLUS_CONTENT}
        >
          {load.status === "loading" && (
            <p className="text-muted-foreground m-0 px-2 py-1.5 text-sm">Loading…</p>
          )}
          {load.status === "error" && (
            <p role="alert" className="text-destructive m-0 px-2 py-1.5 text-sm">
              {load.message}
            </p>
          )}
          {load.status === "ready" && load.list.length === 0 && (
            <p className="text-muted-foreground m-0 px-2 py-1.5 text-sm">
              No connectors for you in this team.
            </p>
          )}
          {load.status === "ready" &&
            load.list.map((c) =>
              c.problem !== null ? (
                <Broken key={c.connectorId} connector={c} />
              ) : (
                <DropdownMenu.CheckboxItem
                  key={c.connectorId}
                  className={PLUS_ITEM}
                  data-kobe-connector={c.connectorId}
                  checked={enabledOf(c)}
                  onSelect={(e) => {
                    // The menu stays open: several can be turned off in a row.
                    e.preventDefault();
                    void toggle(c);
                  }}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    <DropdownMenu.ItemIndicator>
                      <CheckIcon aria-hidden className="size-4" />
                    </DropdownMenu.ItemIndicator>
                  </span>
                  <span className="truncate">{c.name}</span>
                  <span className="text-muted-foreground ms-auto text-xs">
                    {enabledOf(c) ? "On" : "Off"}
                  </span>
                </DropdownMenu.CheckboxItem>
              ),
            )}
          {threadId === null && load.status === "ready" && load.list.length > 0 && (
            <p className="text-muted-foreground m-0 max-w-64 px-2 py-1.5 text-xs">{NOT_STARTED}</p>
          )}
          {error !== null && (
            <p role="alert" className="text-destructive m-0 max-w-64 px-2 py-1.5 text-xs">
              {error}
            </p>
          )}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}
