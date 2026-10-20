/**
 * The panels over the workspace (KOBE-452): the Team and Site consoles, My agents, Skills and the
 * rest of the My area open as one large overlay over the chat instead of leaving it. Each keeps
 * its own address (`/admin/team/...`, `/me/skills`, ...), so a link, a reload and Back work; the
 * root layout keeps the workspace mounted under it (components/shell/workspace-host.tsx).
 */
export type PanelId =
  | "threads"
  | "team-console"
  | "site-console"
  | "administration"
  | "my-agents"
  | "skills"
  | "my-memory"
  | "my-approvals"
  | "my-schedules"
  | "my-connectors"
  | "projects"
  | "my-shared-cases"
  | "my-area";

export interface Panel {
  readonly id: PanelId;
  /** The panel's heading and its dialog's name. */
  readonly title: string;
  /**
   * A single page whose own title would repeat the panel's (the My area pages that opened beside
   * the thread, KOBE-424): the page leaves its h1 out (`EmbeddedPage`).
   */
  readonly embedded: boolean;
}

/** First match wins: the more specific prefixes come first. */
const PANELS: readonly (Panel & { readonly prefix: string })[] = [
  { prefix: "/threads", id: "threads", title: "Threads", embedded: false },
  { prefix: "/admin/team", id: "team-console", title: "Team console", embedded: false },
  { prefix: "/admin/site", id: "site-console", title: "Site console", embedded: false },
  { prefix: "/admin", id: "administration", title: "Administration", embedded: false },
  { prefix: "/me/agents", id: "my-agents", title: "My agents", embedded: false },
  { prefix: "/me/skills", id: "skills", title: "Skills", embedded: false },
  { prefix: "/me/memory", id: "my-memory", title: "My memory", embedded: true },
  { prefix: "/me/approvals", id: "my-approvals", title: "My approvals", embedded: true },
  { prefix: "/me/schedules", id: "my-schedules", title: "My schedules", embedded: true },
  { prefix: "/me/connectors", id: "my-connectors", title: "My connectors", embedded: true },
  { prefix: "/me/projects", id: "projects", title: "Projects", embedded: false },
  { prefix: "/me/shared-cases", id: "my-shared-cases", title: "My shared cases", embedded: false },
  { prefix: "/me", id: "my-area", title: "My area", embedded: false },
];

const within = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/** The panel `pathname` opens over the workspace; undefined for the chat and any other page. */
export function panelOfPath(pathname: string): Panel | undefined {
  const found = PANELS.find((p) => within(pathname, p.prefix));
  if (found === undefined) return undefined;
  const { id, title, embedded } = found;
  return { id, title, embedded };
}

/** The chat itself. */
export const WORKSPACE_PATH = "/";

/** Pages the workspace renders: the chat, and the chat under a panel. */
export function isWorkspacePath(pathname: string): boolean {
  return pathname === WORKSPACE_PATH || panelOfPath(pathname) !== undefined;
}

/** The Threads panel (KOBE-453): the member's threads, from the rail's top line. */
export const THREADS_PANEL_HREF = "/threads";
