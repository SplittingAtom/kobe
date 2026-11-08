"use client";

import type { AgentRosterRow, AgentRosterTab } from "@kobe/protocol";
import { useState } from "react";
import { listRoster } from "../../lib/agents/roster-api";
import { useMutation, useResource } from "../admin/use-resource";

/** Pages after the first: the cursors they were read with, their rows and the next cursor. */
interface More {
  readonly cursors: readonly string[];
  readonly rows: readonly AgentRosterRow[];
  readonly next: string | null;
}

const NONE: More = { cursors: [], rows: [], next: null };

/** First page's rows then the later pages', without a row twice (a row may move between pages). */
function merged(first: readonly AgentRosterRow[], more: readonly AgentRosterRow[]) {
  const seen = new Set(first.map((r) => r.agentId));
  return [...first, ...more.filter((r) => !seen.has(r.agentId))];
}

/**
 * A tab's rows, page by page (ordered by name and id, 200 a page, §6.8). `refresh` after a row
 * action reads the first page and every page loaded since again, so the acted-on row stays in
 * view with what the server now says about it.
 */
export function useRosterRows(teamId: string, tab: AgentRosterTab) {
  const first = useResource(() => listRoster(teamId, tab));
  const [more, setMore] = useState<More>(NONE);
  const paging = useMutation();

  const firstRows = first.state.status === "ready" ? first.state.data.rows : [];
  const nextCursor =
    first.state.status !== "ready"
      ? null
      : more.cursors.length === 0
        ? first.state.data.nextCursor
        : more.next;

  async function loadMore() {
    if (nextCursor === null) return;
    const cursor = nextCursor;
    await paging.run(
      () => listRoster(teamId, tab, cursor),
      (page) => {
        setMore((m) => ({
          cursors: [...m.cursors, cursor],
          rows: [...m.rows, ...page.rows],
          next: page.nextCursor,
        }));
        return null;
      },
    );
  }

  async function refresh() {
    first.reload();
    if (more.cursors.length === 0) return;
    const pages = await Promise.all(more.cursors.map((c) => listRoster(teamId, tab, c)));
    // A page that fails to load again keeps what was shown; the next action tries again.
    if (!pages.every((p) => p.ok)) return;
    const loaded = pages.flatMap((p) => (p.ok ? [p.data] : []));
    setMore({
      cursors: more.cursors,
      rows: loaded.flatMap((p) => p.rows),
      next: loaded.at(-1)?.nextCursor ?? null,
    });
  }

  return {
    state: first.state,
    rows: merged(firstRows, more.rows),
    nextCursor,
    loadMore,
    refresh,
    paging,
  };
}
