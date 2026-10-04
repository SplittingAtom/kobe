import { z } from "zod";

/**
 * Captured subset of Orbit's YAML setup layer (KOBE-90), mirroring `orbit/configs/experiment.py`
 * and `orbit/configs/setup.py` at the pinned release (`ORBIT_PIN`). Both Pydantic models use
 * `extra="forbid"`, so these objects are strict too. CI loads the mapper's fixtures with Orbit's
 * real loader (`ci/orbit/check-fixtures.py`); this schema is the fast unit-test twin of that check.
 * Bump `ORBIT_PIN` together with `ci/orbit/` and re-check this file against the new release.
 */
export const ORBIT_PIN = { version: "1.0.3", commit: "588b3035f92450ec4f0496bb8b629daa205e84c7" };

/** `orbit/tools.py` `_TOOL_NAME`: tool binding names. */
export const ORBIT_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** `orbit/tools.py` `_RUNTIME_TOOL_NAMES`: owned by Orbit's runtime, never bindable. */
export const ORBIT_RESERVED_TOOLS: ReadonlySet<string> = new Set([
  "submit",
  "handoff",
  "secret_channel",
  "channel_post",
  "channel_read",
  "channel_list",
  "post_message",
  "read_messages",
  "list_boards",
]);

export const orbitToolNameSchema = z
  .string()
  .regex(ORBIT_TOOL_NAME, {
    error: (i) => `tool "${String(i.input)}": names allow 1-64 ASCII letters, digits, _ or -`,
  })
  .refine((n) => !ORBIT_RESERVED_TOOLS.has(n), {
    error: (i) => `tool "${String(i.input)}" is reserved by Orbit's runtime`,
  });

/** `AgentSpec` (setup.py): the fields the mapper may set. */
export const orbitAgentSpecSchema = z.strictObject({
  name: z.string().min(1),
  role: z.string(),
  model: z.string().optional(),
  system_prompt: z.string(),
  tools: z.array(orbitToolNameSchema).refine((t) => new Set(t).size === t.length, "duplicate tool"),
});

/** `ExperimentConfig` (experiment.py) restricted to what the export writes. */
export const orbitExperimentSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().optional(),
  setup: z.strictObject({
    agents: z.array(orbitAgentSpecSchema).min(1),
    edges: z.array(z.never()),
  }),
  metadata: z.record(z.string(), z.unknown()),
});

export type OrbitAgentSpec = z.infer<typeof orbitAgentSpecSchema>;
export type OrbitExperiment = z.infer<typeof orbitExperimentSchema>;
