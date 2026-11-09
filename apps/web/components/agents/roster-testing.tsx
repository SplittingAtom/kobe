// Shared by the Agents page tests (KOBE-569, KOBE-570): the page with Next's search params, the
// roles' permissions, and row helpers.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { useEffect, useState } from "react";
import { expect } from "vitest";
import type { stubApi } from "../admin/testing";
import { AgentsPage } from "./agents-page";

/** Navigates the page's `?tab=` as a link or Back would (Next's search params, not a reload). */
export type Navigator = { current: ((search: string) => void) | null };

/**
 * The page with Next's search params, as the app router provides them. A test that follows links
 * passes `navigator` (a ref it owns) and calls `navigator.current?.(search)`.
 */
export function Page({
  search = "",
  navigator,
}: {
  readonly search?: string;
  readonly navigator?: Navigator;
}) {
  const [current, setCurrent] = useState(search);
  useEffect(() => {
    if (!navigator) return;
    navigator.current = setCurrent;
    return () => {
      navigator.current = null;
    };
  }, [navigator]);
  return (
    <SearchParamsContext.Provider value={new URLSearchParams(current)}>
      <AgentsPage />
    </SearchParamsContext.Provider>
  );
}

export const ROSTER = (tab: string) => `GET /v1/agents/roster?tab=${tab}`;

export const MEMBER = { role: "member", permissions: ["team.agents.use"] } as const;
export const BUILDER = {
  role: "contributor",
  permissions: ["team.agents.use", "team.agents.build"],
} as const;
export const TEAM_ADMIN = {
  role: "team_admin",
  permissions: [
    "team.agents.use",
    "team.agents.build",
    "team.agents.manage",
    "team.agents.suspend",
  ],
} as const;
export const SITE_ADMIN = { ...MEMBER, siteAdmin: true } as const;

/** The labels in the row's ⋯ menu (none when the row offers no action), closing it again. */
export async function rowActions(agent: string): Promise<string[]> {
  await screen.findByRole("rowheader", { name: startsWith(agent) });
  const button = screen.queryByRole("button", { name: `Actions for ${agent}` });
  if (!button) return [];
  await userEvent.click(button);
  const menu = await screen.findByRole("menu");
  const labels = within(menu)
    .getAllByRole("menuitem")
    .map((i) => i.textContent ?? "");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  return labels;
}

export async function rowAction(agent: string, action: string) {
  await userEvent.click(await screen.findByRole("button", { name: `Actions for ${agent}` }));
  await userEvent.click(await screen.findByRole("menuitem", { name: action }));
}

export const rowOf = async (agent: string) =>
  must((await screen.findByRole("rowheader", { name: startsWith(agent) })).closest("tr"));

/** A row header's accessible name starts with the agent's name (then badges, description). */
export const startsWith = (name: string): RegExp =>
  new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

export function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error("missing");
  return v;
}

export const bodyOf = (calls: ReturnType<typeof stubApi>, method: string, url: string) =>
  JSON.parse(String(must(calls.find((c) => c.method === method && c.url === url)).body));
