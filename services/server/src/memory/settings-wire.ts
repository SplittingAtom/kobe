import { z } from "zod";
import { MODEL_ALIAS_PATTERN } from "@kobe/db";
import { memorySiteSettingsFields, memorySiteSettingsSchema } from "./site-settings.js";
import type { Change, SiteMemorySwitches, WorkspaceMemorySwitches } from "./switch-model.js";

/**
 * Wire shapes of `/v1/memory/settings` (KOBE-381), shared by the route and the Kobe admin MCP
 * tools `team_memory_get` / `team_memory_set`, so the two cannot drift (contract test in
 * `kobe-mcp/tools/team-memory.test.ts`). Server-local: the published protocol keeps the D24
 * `memorySettingsSchema` (the two Notes switches), which both levels still accept.
 */

const alias = z.string().max(64).regex(new RegExp(MODEL_ALIAS_PATTERN));

/** Workspace level: every switch, plus the learning model override (null = none). */
export const workspaceMemoryWireSchema = z.strictObject({
  memory_enabled: z.boolean(),
  project_memory_enabled: z.boolean(),
  memories_enabled: z.boolean(),
  workspace_memories_enabled: z.boolean(),
  site_memories_enabled: z.boolean(),
  learn_enabled: z.boolean(),
  site_proposals_enabled: z.boolean(),
  learning_model_alias: alias.nullable(),
});
export type WorkspaceMemoryWire = z.infer<typeof workspaceMemoryWireSchema>;
export const WORKSPACE_WIRE_KEYS = Object.keys(
  workspaceMemoryWireSchema.shape,
) as (keyof WorkspaceMemoryWire)[];

export const siteSwitchesWireShape = {
  memory_enabled: z.boolean(),
  project_memory_enabled: z.boolean(),
  memories_enabled: z.boolean(),
  portable_enabled: z.boolean(),
  learn_enabled: z.boolean(),
  site_proposals_enabled: z.boolean(),
} as const;

/** Site level: the switches and the Site memory settings document. */
export const siteMemoryWireSchema = z.strictObject({
  ...siteSwitchesWireShape,
  settings: memorySiteSettingsSchema,
  /** Model settings whose stored alias is no longer in the catalog (shown as removed). */
  removed_models: z.array(z.enum(["learning_model_alias", "embedding_model_alias"])),
});
export type SiteMemoryWire = z.infer<typeof siteMemoryWireSchema>;

/** PUT bodies: any subset; the team level may carry `expected` (the full before-state). */
export const workspacePutSchema = workspaceMemoryWireSchema
  .partial()
  .extend({ expected: workspaceMemoryWireSchema.optional() });

export const sitePutSchema = z.strictObject({
  ...(Object.fromEntries(
    Object.entries(siteSwitchesWireShape).map(([k, v]) => [k, v.optional()]),
  ) as { [K in keyof typeof siteSwitchesWireShape]: z.ZodOptional<z.ZodBoolean> }),
  settings: z.strictObject(memorySiteSettingsFields).partial().optional(),
});

export const toWorkspaceWire = (s: WorkspaceMemorySwitches): WorkspaceMemoryWire => ({
  memory_enabled: s.memoryEnabled,
  project_memory_enabled: s.projectMemoryEnabled,
  memories_enabled: s.memoriesEnabled,
  workspace_memories_enabled: s.workspaceMemoriesEnabled,
  site_memories_enabled: s.siteMemoriesEnabled,
  learn_enabled: s.learnEnabled,
  site_proposals_enabled: s.siteProposalsEnabled,
  learning_model_alias: s.learningModelAlias,
});

export const fromWorkspaceWire = (w: WorkspaceMemoryWire): WorkspaceMemorySwitches => ({
  memoryEnabled: w.memory_enabled,
  projectMemoryEnabled: w.project_memory_enabled,
  memoriesEnabled: w.memories_enabled,
  workspaceMemoriesEnabled: w.workspace_memories_enabled,
  siteMemoriesEnabled: w.site_memories_enabled,
  learnEnabled: w.learn_enabled,
  siteProposalsEnabled: w.site_proposals_enabled,
  learningModelAlias: w.learning_model_alias,
});

/** A partial wire body as a partial change (absent keys stay absent). */
export function workspaceChangeOf(
  body: Change<WorkspaceMemoryWire>,
): Change<WorkspaceMemorySwitches> {
  return fromWorkspaceWire(body as WorkspaceMemoryWire);
}

export const toSiteSwitchesWire = (s: SiteMemorySwitches) => ({
  memory_enabled: s.memoryEnabled,
  project_memory_enabled: s.projectMemoryEnabled,
  memories_enabled: s.memoriesEnabled,
  portable_enabled: s.portableEnabled,
  learn_enabled: s.learnEnabled,
  site_proposals_enabled: s.siteProposalsEnabled,
});

export function siteSwitchChangeOf(
  body: Change<ReturnType<typeof toSiteSwitchesWire>>,
): Change<SiteMemorySwitches> {
  return {
    memoryEnabled: body.memory_enabled,
    projectMemoryEnabled: body.project_memory_enabled,
    memoriesEnabled: body.memories_enabled,
    portableEnabled: body.portable_enabled,
    learnEnabled: body.learn_enabled,
    siteProposalsEnabled: body.site_proposals_enabled,
  };
}
