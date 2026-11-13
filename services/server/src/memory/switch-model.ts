import type { MemoryScope, SemanticMemoryScope } from "@kobe/protocol";

/**
 * The memory switches as values (KOBE-381, SM27), without the database: what each level stores
 * and what applies to one Workspace. Two levels, Site (site admins) and Workspace (team admins);
 * every switch is AND-ed across the levels that have it, and every one defaults to on (a Site key
 * or Workspace value that was never written reads as on, so an upgrade changes nothing).
 *
 * `memoryEnabled` is the master switch: off = no Notes (file memory, D24) **and** no Memories
 * (semantic memory). Turning any switch off stops use; it never deletes anything.
 */

/** Site console › Settings › Memory. */
export interface SiteMemorySwitches {
  /** Master: Notes and Memories on this Site. */
  readonly memoryEnabled: boolean;
  /** Project Notes (D24). */
  readonly projectMemoryEnabled: boolean;
  /** Memories (semantic memory items) on this Site. */
  readonly memoriesEnabled: boolean;
  /** Portable preferences: a person's preferences that follow them into every Workspace. */
  readonly portableEnabled: boolean;
  /** Learn from this chat. */
  readonly learnEnabled: boolean;
  /** Members may propose Workspace memories to the Site. */
  readonly siteProposalsEnabled: boolean;
}

/** Workspace settings › Memory. */
export interface WorkspaceMemorySwitches {
  readonly memoryEnabled: boolean;
  readonly projectMemoryEnabled: boolean;
  readonly memoriesEnabled: boolean;
  /** Workspace memories (wire scope `team`). */
  readonly workspaceMemoriesEnabled: boolean;
  /** Site memories reach this Workspace's runs. Policy ignores it. */
  readonly siteMemoriesEnabled: boolean;
  readonly learnEnabled: boolean;
  readonly siteProposalsEnabled: boolean;
  /**
   * The Workspace's learning model (a model alias): when set, Learn uses it (it must be enabled
   * in the Workspace) instead of the Site's (`learning-model.ts`). Null = the Site's.
   */
  readonly learningModelAlias: string | null;
}

export const SITE_SWITCH_NAMES = [
  "memoryEnabled",
  "projectMemoryEnabled",
  "memoriesEnabled",
  "portableEnabled",
  "learnEnabled",
  "siteProposalsEnabled",
] as const satisfies readonly (keyof SiteMemorySwitches)[];

export const WORKSPACE_SWITCH_NAMES = [
  "memoryEnabled",
  "projectMemoryEnabled",
  "memoriesEnabled",
  "workspaceMemoriesEnabled",
  "siteMemoriesEnabled",
  "learnEnabled",
  "siteProposalsEnabled",
] as const satisfies readonly (keyof WorkspaceMemorySwitches)[];

export const SITE_SWITCHES_ON: SiteMemorySwitches = Object.freeze({
  memoryEnabled: true,
  projectMemoryEnabled: true,
  memoriesEnabled: true,
  portableEnabled: true,
  learnEnabled: true,
  siteProposalsEnabled: true,
});

export const WORKSPACE_SWITCHES_ON: WorkspaceMemorySwitches = Object.freeze({
  memoryEnabled: true,
  projectMemoryEnabled: true,
  memoriesEnabled: true,
  workspaceMemoriesEnabled: true,
  siteMemoriesEnabled: true,
  learnEnabled: true,
  siteProposalsEnabled: true,
  learningModelAlias: null,
});

/** A change: any subset of `T`, where an absent or undefined key means "leave as is". */
export type Change<T> = { readonly [K in keyof T]?: T[K] | undefined };

/** What applies to one Workspace now. */
export interface EffectiveMemory {
  /** Notes (D24 file memory) per scope; the shape every Notes caller already uses. */
  readonly notes: Readonly<Record<MemoryScope, boolean>>;
  /** Memories at all (master and both Memories switches). */
  readonly memories: boolean;
  /** Which semantic scopes reach this Workspace's runs and editors. */
  readonly scopes: Readonly<Record<SemanticMemoryScope, boolean>>;
  /**
   * Site Policy items reach this Workspace's runs. Needs Memories, and ignores the Workspace's
   * "Site memories reach this Workspace's runs" switch (SM27).
   */
  readonly policy: boolean;
  /** The Learn switches allow learning (a learning model is checked separately). */
  readonly learn: boolean;
  /** Members may propose Workspace memories to the Site. */
  readonly siteProposals: boolean;
}

/** The AND of both levels. Pure; the effective-switch matrix tests cover every switch. */
export function effectiveMemory(
  site: SiteMemorySwitches,
  ws: WorkspaceMemorySwitches,
): EffectiveMemory {
  const master = site.memoryEnabled && ws.memoryEnabled;
  const memories = master && site.memoriesEnabled && ws.memoriesEnabled;
  return {
    notes: {
      user: master,
      project: master && site.projectMemoryEnabled && ws.projectMemoryEnabled,
    },
    memories,
    scopes: {
      user: memories,
      portable: memories && site.portableEnabled,
      team: memories && ws.workspaceMemoriesEnabled,
      site: memories && ws.siteMemoriesEnabled,
    },
    policy: memories,
    learn: memories && site.learnEnabled && ws.learnEnabled,
    siteProposals:
      memories &&
      ws.workspaceMemoriesEnabled &&
      site.siteProposalsEnabled &&
      ws.siteProposalsEnabled,
  };
}
