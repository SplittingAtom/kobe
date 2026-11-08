/**
 * The Agents page's tabs (KOBE-569, spec agents-roster AR1): Personal, Team and Site, in that
 * order. The tab is in the address (`?tab=`) so a link opens it, and the last one used is
 * remembered in this browser (localStorage, like the Workbench draft tabs; transient state, so a
 * blocked storage only loses the memory).
 *
 * A plain module: the page's server component reads `?tab=` with `agentTabParam`.
 */
import { AGENT_ROSTER_TABS, type AgentRosterTab } from "@kobe/protocol";

export const AGENT_TABS = AGENT_ROSTER_TABS;
export type AgentTab = AgentRosterTab;

export const DEFAULT_AGENT_TAB: AgentTab = "personal";
export const AGENT_TAB_KEY = "kobe.agents.tab";

const isAgentTab = (v: unknown): v is AgentTab =>
  typeof v === "string" && (AGENT_TABS as readonly string[]).includes(v);

/** The tab `?tab=` names: null without one, Personal for a value that is no tab. */
export function agentTabParam(value: string | string[] | undefined): AgentTab | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (v === undefined) return null;
  return isAgentTab(v) ? v : DEFAULT_AGENT_TAB;
}

/** The tab last used in this browser, if any. */
export function rememberedAgentTab(): AgentTab | null {
  try {
    const stored = localStorage.getItem(AGENT_TAB_KEY);
    return isAgentTab(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** Remembers the tab; storage that refuses only loses the memory. */
export function rememberAgentTab(tab: AgentTab): void {
  try {
    localStorage.setItem(AGENT_TAB_KEY, tab);
  } catch {
    // Private mode or blocked site data: the page still works, it just won't remember.
  }
}

/** The tab the page opens on: the address's, else the remembered one, else Personal. */
export function openingAgentTab(requested: AgentTab | null): AgentTab {
  return requested ?? rememberedAgentTab() ?? DEFAULT_AGENT_TAB;
}
