import { z } from "zod";
import { idSchema, timestampSchema, utf8ByteLength, uuidSchema } from "./common.js";
import { projectProposeOkFields, projectToolsRequestSchema } from "./projects.js";
import {
  webSearchOkFields,
  webSearchToolsRequestSchema,
  webSearchUnavailableFields,
} from "./web-search.js";
import { fileShareOkFields, fileShareToolsRequestSchema } from "./files.js";

/**
 * Artifacts contract (KOBE-127 = 55a of KOBE-55, spec D25; binding design in docs/ledger/KOBE-55.md).
 * Additive: nothing here changes an existing frame, and an agent without
 * {@link CAPABILITY_ARTIFACTS} never registers the tools.
 *
 * Flow: the model calls `create_artifact` / `update_artifact` (Pi tools of the `kobe-tools`
 * extension) -> kobe-policy `policy.check` as for any tool -> once allowed, kobe-tools sends the
 * call to kobe-sandbox-agent on the {@link KOBE_TOOLS_FD} channel -> the agent sends the
 * `artifact.put` frame (frames.ts) and waits for `artifact.result` -> the server stores the
 * content, emits `artifact.created` / `artifact.updated` (events.ts) and answers; the tool result
 * is that answer. The server never trusts the input of `artifact.put` on its own: it must equal
 * the input it allowed for that `tool_call_id` (hash of `canonicalJson`, KOBE-129).
 */

/** `hello.capabilities` entry of an agent that registers the artifact tools and sends `artifact.put`. */
export const CAPABILITY_ARTIFACTS = "artifacts";

export const ARTIFACT_KINDS = ["html", "svg", "markdown", "mermaid", "code", "csv"] as const;
export const artifactKindSchema = z.enum(ARTIFACT_KINDS);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

/** Largest artifact content (UTF-8 bytes) per create/update. */
export const ARTIFACT_CONTENT_MAX_BYTES = 512 * 1024;
export const ARTIFACT_TITLE_MAX = 200;
/** `language` of a `code` artifact, e.g. `python`, `c++`. */
export const ARTIFACT_LANGUAGE_PATTERN = /^[a-z0-9][a-z0-9+#.-]{0,31}$/;

const content = z.string().refine((s) => utf8ByteLength(s) <= ARTIFACT_CONTENT_MAX_BYTES, {
  message: `content exceeds ${ARTIFACT_CONTENT_MAX_BYTES} bytes`,
});
const title = z.string().min(1).max(ARTIFACT_TITLE_MAX);

/**
 * Tool inputs. The serialized input must also fit `policy.check` (1 MiB); JSON escaping can make
 * 512 KiB of content larger than that, so `kobe-tools` refuses a call that would not fit with a
 * tool error before sending anything.
 */
export const createArtifactInputSchema = z
  .strictObject({
    kind: artifactKindSchema,
    title,
    content,
    language: z.string().regex(ARTIFACT_LANGUAGE_PATTERN).optional(),
  })
  .refine((v) => v.language === undefined || v.kind === "code", {
    message: "language is only allowed for kind code",
    path: ["language"],
  });
export type CreateArtifactInput = z.infer<typeof createArtifactInputSchema>;

export const updateArtifactInputSchema = z.strictObject({
  artifact_id: uuidSchema,
  content,
  title: title.optional(),
});
export type UpdateArtifactInput = z.infer<typeof updateArtifactInputSchema>;

export const ARTIFACT_TOOLS = ["create_artifact", "update_artifact"] as const;
export type ArtifactToolName = (typeof ARTIFACT_TOOLS)[number];

/** Input schema per tool name (the server's policy input validation uses this, KOBE-129). */
export const artifactToolInputSchema = {
  create_artifact: createArtifactInputSchema,
  update_artifact: updateArtifactInputSchema,
} as const;

/** `{ tool, input }` pairs: the input must match its tool. */
export const artifactCallShape = {
  create: { tool: z.literal("create_artifact"), input: createArtifactInputSchema },
  update: { tool: z.literal("update_artifact"), input: updateArtifactInputSchema },
} as const;

/** Server answer codes. Open on the sandbox side (any `^[a-z][a-z0-9_]{0,63}$` decodes). */
export const ARTIFACT_ERROR_CODES = [
  "not_allowed",
  "not_found",
  "invalid_input",
  "too_large",
  "storage_failed",
] as const;
const errorCode = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const artifactErrorSchema = z.strictObject({
  code: errorCode,
  message: z.string().max(2000),
});
export type ArtifactError = z.infer<typeof artifactErrorSchema>;

/** Result fields shared by the `artifact.result` frame and the kobe-tools response. */
export const artifactOkFields = {
  ok: z.literal(true),
  artifact_id: uuidSchema,
  version: z.number().int().positive(),
} as const;
export const artifactFailFields = { ok: z.literal(false), error: artifactErrorSchema } as const;

// ----------------------------------------------------------------------------- kobe-tools channel

/**
 * File descriptor of the kobe-tools channel (D13): inherited by the Pi process like the policy
 * channel, JSON lines with the same framing and fail-closed rules (a closed or silent channel is a
 * tool error, never a retry elsewhere). 30 s timeout per request ({@link KOBE_TOOLS_TIMEOUT_MS}).
 * Later ops get their own `op`: `file.share` (files.ts, KOBE-147); `remember` is not defined yet.
 */
export const KOBE_TOOLS_FD = 4;
export const KOBE_TOOLS_TIMEOUT_MS = 30_000;

export const kobeToolsRequestSchema = z.union([
  z.strictObject({
    id: idSchema,
    op: z.literal("artifact.put"),
    tool_call_id: idSchema,
    ...artifactCallShape.create,
  }),
  z.strictObject({
    id: idSchema,
    op: z.literal("artifact.put"),
    tool_call_id: idSchema,
    ...artifactCallShape.update,
  }),
  fileShareToolsRequestSchema, // KOBE-147 (files.ts)
  projectToolsRequestSchema, // KOBE-159 (projects.ts)
  webSearchToolsRequestSchema, // KOBE-114 (web-search.ts)
]);
export type KobeToolsRequest = z.infer<typeof kobeToolsRequestSchema>;

export const kobeToolsResponseSchema = z.union([
  z.strictObject({ id: idSchema, ...artifactOkFields }),
  z.strictObject({ id: idSchema, ...fileShareOkFields }), // KOBE-147 (files.ts)
  z.strictObject({ id: idSchema, ...projectProposeOkFields }), // KOBE-159 (projects.ts)
  z.strictObject({ id: idSchema, ...webSearchOkFields }), // KOBE-114 (web-search.ts)
  z.strictObject({ id: idSchema, ...webSearchUnavailableFields }), // KOBE-114
  z.strictObject({ id: idSchema, ...artifactFailFields }),
]);
export type KobeToolsResponse = z.infer<typeof kobeToolsResponseSchema>;

// ----------------------------------------------------------------------------- REST (/v1/artifacts)

/** `GET /v1/artifacts?thread_id=` -> `{ artifacts: ArtifactSummary[] }`. */
export const artifactSummarySchema = z.strictObject({
  id: uuidSchema,
  thread_id: uuidSchema,
  kind: artifactKindSchema,
  title: z.string().min(1).max(ARTIFACT_TITLE_MAX),
  language: z.string().regex(ARTIFACT_LANGUAGE_PATTERN).nullable(),
  current_version: z.number().int().positive(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type ArtifactSummary = z.infer<typeof artifactSummarySchema>;

export const artifactListResponseSchema = z.strictObject({
  artifacts: z.array(artifactSummarySchema),
});
export type ArtifactListResponse = z.infer<typeof artifactListResponseSchema>;

export const artifactVersionInfoSchema = z.strictObject({
  version: z.number().int().positive(),
  size_bytes: z.number().int().nonnegative(),
  created_at: timestampSchema,
});
export type ArtifactVersionInfo = z.infer<typeof artifactVersionInfoSchema>;

/** `GET /v1/artifacts/:id`. */
export const artifactDetailSchema = artifactSummarySchema.extend({
  versions: z.array(artifactVersionInfoSchema),
});
export type ArtifactDetail = z.infer<typeof artifactDetailSchema>;
