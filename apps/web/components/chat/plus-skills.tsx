"use client";

import { WandSparklesIcon, XIcon } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useEffect, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { listChatSkills } from "../../lib/chat/composer-plus-api";
import { chatPortalContainer } from "../ui/chat-portal";
import { useChatSession } from "./kobe-runtime";
import { PLUS_CONTENT, PLUS_ITEM } from "./plus-menu-styles";

/** From this many skills on, the submenu offers a filter. */
export const SKILL_FILTER_FROM = 7;

type Load =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly names: readonly string[] }
  | { readonly status: "error"; readonly message: string };

/** The skills a run here loads: the thread's, or a new conversation's with the picked agent. */
function useChatSkills(threadId: string | null, open: boolean): Load {
  const session = useChatSession();
  const draftAgent = useSyncExternalStore(
    session.subscribeDraftAgent,
    () => session.draftAgent,
    () => null,
  );
  const agentId = draftAgent?.id ?? null;
  const [load, setLoad] = useState<Load>({ status: "loading" });
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setLoad({ status: "loading" });
    const at = threadId === null ? { agentId } : { threadId };
    void listChatSkills(session.teamId, at).then((res) => {
      if (!alive) return;
      setLoad(
        res.ok
          ? { status: "ready", names: res.data.skills.map((s) => s.name) }
          : { status: "error", message: res.error.message },
      );
    });
    return () => {
      alive = false;
    };
  }, [session.teamId, threadId, agentId, open]);
  return load;
}

/** The draft's picked skill (KOBE-451), live. */
export function useSkillPick(draft: string): string | undefined {
  const store = useChatSession().skillPicks;
  return useSyncExternalStore(
    store.subscribe,
    () => store.get(draft),
    () => store.get(draft),
  );
}

/**
 * The + menu's Skills (KOBE-451): the skills a run here would load (the server's effective set).
 * Choosing one puts it on the message as a removable chip; the server refuses one outside the set.
 */
export function SkillsSubmenu({
  draft,
  threadId,
  open,
}: {
  readonly draft: string;
  readonly threadId: string | null;
  readonly open: boolean;
}) {
  const session = useChatSession();
  const load = useChatSkills(threadId, open);
  const picked = useSkillPick(draft);
  const [filter, setFilter] = useState("");
  const names = load.status === "ready" ? load.names : [];
  const shown = names.filter((n) => n.includes(filter.trim().toLowerCase()));
  // The filter field keeps its keys: typeahead and the menu's own keys skip it (not Escape).
  const keepKeys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Escape" && e.key !== "ArrowDown" && e.key !== "ArrowUp") e.stopPropagation();
  };
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className={PLUS_ITEM} data-kobe-plus="skills">
        <WandSparklesIcon aria-hidden className="size-4 shrink-0" />
        Skills
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal container={chatPortalContainer()}>
        <DropdownMenu.SubContent
          data-kobe-portal
          aria-label="Skills"
          sideOffset={4}
          className={`${PLUS_CONTENT} max-h-80 overflow-y-auto`}
        >
          {names.length >= SKILL_FILTER_FROM && (
            <input
              type="search"
              aria-label="Filter skills"
              placeholder="Filter skills"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={keepKeys}
              className="border-input mb-1 w-full rounded-md border px-2 py-1 text-sm"
            />
          )}
          {load.status === "loading" && (
            <p className="text-muted-foreground m-0 px-2 py-1.5 text-sm">Loading…</p>
          )}
          {load.status === "error" && (
            <p role="alert" className="text-destructive m-0 px-2 py-1.5 text-sm">
              {load.message}
            </p>
          )}
          {load.status === "ready" && names.length === 0 && (
            <p className="text-muted-foreground m-0 px-2 py-1.5 text-sm">
              No skills for this agent here.
            </p>
          )}
          {load.status === "ready" && names.length > 0 && shown.length === 0 && (
            <p className="text-muted-foreground m-0 px-2 py-1.5 text-sm">No skill matches.</p>
          )}
          {shown.map((name) => (
            <DropdownMenu.Item
              key={name}
              className={PLUS_ITEM}
              data-kobe-skill={name}
              onSelect={() => session.skillPicks.set(draft, name)}
            >
              <WandSparklesIcon aria-hidden className="size-4 shrink-0" />
              <span className="truncate">{name}</span>
              {picked === name && (
                <span className="text-muted-foreground ms-auto text-xs">picked</span>
              )}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}

/** The picked skill on the composer (KOBE-451): sent with the next message; × removes it. */
export function SkillPickChip({ draft }: { readonly draft: string }) {
  const session = useChatSession();
  const picked = useSkillPick(draft);
  if (picked === undefined) return null;
  return (
    <div className="px-2">
      <span
        data-kobe-skill-chip={picked}
        className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs"
      >
        <WandSparklesIcon aria-hidden className="size-3" />
        Skill: {picked}
        <button
          type="button"
          aria-label={`Remove the skill ${picked}`}
          className="rounded-full"
          onClick={() => session.skillPicks.clear(draft)}
        >
          <XIcon aria-hidden className="size-3" />
        </button>
      </span>
    </div>
  );
}
