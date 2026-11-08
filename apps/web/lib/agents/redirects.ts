/**
 * "My agents" became the Agents page (KOBE-569, spec agents-roster AR1/AR15): `/me/agents` lands
 * on its Personal tab, and every deeper address (an agent's editor, its shared cases) keeps
 * working at the same path under `/agents`. Free of components, so next.config.ts can import it.
 * The console's lists `/admin/team/agents` and `/admin/site/gallery` land on the Team and Site
 * tabs, which carry their columns and actions (KOBE-570, AR12); `/admin/team/inventory` stays
 * for the team's skills and connectors (its agents point to the Team tab). Only the list pages move: the editors under them (`/admin/team/agents/:id`, `/new`, `/admin/site/gallery/:id`)
 * stay where they are.
 */
export interface AgentsRedirect {
  readonly source: string;
  readonly destination: string;
  readonly permanent: boolean;
}

export const AGENTS_PAGE = "/agents";

/** An agent's editor (own personal agents) or its read-only view (anyone else who may read it). */
export const agentPageHref = (agentId: string): string =>
  `${AGENTS_PAGE}/${encodeURIComponent(agentId)}`;

export const NEW_AGENT_HREF = `${AGENTS_PAGE}/new`;

/** The Team and Site tabs (KOBE-570): where the console's agent lists moved. */
export const TEAM_TAB_HREF = `${AGENTS_PAGE}?tab=team`;
export const SITE_TAB_HREF = `${AGENTS_PAGE}?tab=site`;

export function agentsRedirects(): AgentsRedirect[] {
  return [
    // Not permanent (no cached 308): the old address may be reused later.
    { source: "/me/agents", destination: `${AGENTS_PAGE}?tab=personal`, permanent: false },
    { source: "/me/agents/:path+", destination: `${AGENTS_PAGE}/:path+`, permanent: false },
    { source: "/admin/team/agents", destination: TEAM_TAB_HREF, permanent: false },
    { source: "/admin/site/gallery", destination: SITE_TAB_HREF, permanent: false },
  ];
}
