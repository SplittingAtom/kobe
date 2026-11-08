/**
 * "My agents" became the Agents page (KOBE-569, spec agents-roster AR1/AR15): `/me/agents` lands
 * on its Personal tab, and every deeper address (an agent's editor, its shared cases) keeps
 * working at the same path under `/agents`. Free of components, so next.config.ts can import it.
 * `/admin/team/agents`, `/admin/team/inventory` and `/admin/site/gallery` stay until the tabs
 * carry their actions (KOBE-570).
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

export function agentsRedirects(): AgentsRedirect[] {
  return [
    // Not permanent (no cached 308): the old address may be reused later.
    { source: "/me/agents", destination: `${AGENTS_PAGE}?tab=personal`, permanent: false },
    { source: "/me/agents/:path+", destination: `${AGENTS_PAGE}/:path+`, permanent: false },
  ];
}
