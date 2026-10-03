import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  AGENT_FILE_LIMITS,
  agentWarnings,
  parseAgentFile,
  serializeAgentFile,
  validateAgentDefinition,
  type AgentDefinition,
  type AgentFileIssue,
} from "@kobe/agent-file";
import type { AgentAccess } from "./access.js";
import type { AgentRecord, CreateError } from "./store.js";
import type { AgentVersionRecord, AgentVersionSummary, PublishError } from "./versions.js";

/**
 * HTTP plumbing shared by the team (`/v1/agents`) and gallery (`/v1/install/gallery/agents`)
 * routes: request bodies (JSON or an agent markdown file), response shapes, ETags, errors.
 */

/** JSON bodies may escape characters (a 100 KiB prompt can grow), files are capped at their limit. */
const MAX_REQUEST_BYTES = 4 * AGENT_FILE_LIMITS.fileBytes;
const MARKDOWN_TYPES = new Set(["text/markdown", "text/x-markdown", "text/plain"]);

export const agentBodyLimit = bodyLimit({
  maxSize: MAX_REQUEST_BYTES,
  onError: (c) =>
    c.json({ code: "payload_too_large", message: "That agent is too large to upload." }, 413),
});

export type AgentInput =
  | {
      ok: true;
      definition: AgentDefinition;
      meta: Record<string, unknown>;
      /** An imported agent file or a JSON body (audit, KOBE-15). */
      source: "import" | "json";
    }
  | { ok: false; response: Response };

/**
 * Reads an agent from the request: a JSON `{ frontmatter, prompt, ...meta }` or, with a markdown
 * content type, the agent file itself (import; meta then comes from the query string).
 */
export async function readAgentInput(c: Context): Promise<AgentInput> {
  const type = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (MARKDOWN_TYPES.has(type)) {
    const result = parseAgentFile(await c.req.text());
    if (!result.ok) return { ok: false, response: invalidAgent(c, result.issues) };
    return { ok: true, definition: result.definition, meta: c.req.query(), source: "import" };
  }
  if (type !== "application/json") {
    return {
      ok: false,
      response: c.json(
        {
          code: "unsupported_media_type",
          message: "Send JSON or an agent markdown file (text/markdown).",
        },
        415,
      ),
    };
  }
  const body: unknown = await c.req.json().catch(() => null);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, response: invalidRequest(c, "Send a JSON object.") };
  }
  const { frontmatter, prompt, ...meta } = body as Record<string, unknown>;
  const result = validateAgentDefinition({ frontmatter, prompt });
  if (!result.ok) return { ok: false, response: invalidAgent(c, result.issues) };
  return { ok: true, definition: result.definition, meta, source: "json" };
}

export type IfMatch =
  | { readonly kind: "revision"; readonly revision: number }
  | { readonly kind: "any" }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" };

/**
 * Parses `If-Match` into an expected draft revision. Edits must send it (428 otherwise) so two
 * editors can't silently overwrite each other; `*` is an explicit "overwrite whatever is there".
 */
export function readIfMatch(c: Context): IfMatch {
  const header = c.req.header("if-match")?.trim();
  if (header === undefined || header === "") return { kind: "missing" };
  if (header === "*") return { kind: "any" };
  const match = /^(?:W\/)?"(\d{1,9})"$/.exec(header);
  return match?.[1] ? { kind: "revision", revision: Number(match[1]) } : { kind: "invalid" };
}

/** Rejects a missing or malformed If-Match; otherwise the revision to expect (undefined: any). */
export function ifMatchRevision(
  c: Context,
): { ok: true; revision: number | undefined } | { ok: false; response: Response } {
  const ifMatch = readIfMatch(c);
  switch (ifMatch.kind) {
    case "revision":
      return { ok: true, revision: ifMatch.revision };
    case "any":
      return { ok: true, revision: undefined };
    case "missing":
      return {
        ok: false,
        response: c.json(
          {
            code: "if_match_required",
            message: "Send If-Match with the agent's ETag (or * to overwrite).",
          },
          428,
        ),
      };
    case "invalid":
      return { ok: false, response: invalidRequest(c, 'If-Match must be an ETag like "3" or *.') };
  }
}

export const etag = (agent: AgentRecord): string => `"${agent.revision}"`;

/** What anyone who can see the agent gets: enough to pick and start it (D19 starters). */
export function agentSummary(agent: AgentRecord, access: AgentAccess) {
  const { name, description, icon, starters } = agent.frontmatter;
  return {
    id: agent.id,
    scope: agent.scope,
    slug: agent.slug,
    name,
    ...(description !== undefined ? { description } : {}),
    ...(icon !== undefined ? { icon } : {}),
    starters: starters ?? [],
    status: agent.status,
    ownerUserId: agent.ownerUserId,
    currentVersion: agent.currentVersion,
    archivedAt: agent.archivedAt?.toISOString() ?? null,
    revision: agent.revision,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    canEdit: access.edit,
  };
}

/** Summary plus the full draft, for callers allowed to read the definition. */
export function agentDetail(agent: AgentRecord, access: AgentAccess) {
  return {
    ...agentSummary(agent, access),
    frontmatter: agent.frontmatter,
    prompt: agent.prompt,
  };
}

export function agentResponse(
  c: Context,
  agent: AgentRecord,
  access: AgentAccess,
  status: 200 | 201 = 200,
) {
  c.header("ETag", etag(agent));
  // Broad policy requests are accepted but flagged; they never grant anything (agent-file schema).
  return c.json(
    { agent: agentDetail(agent, access), warnings: agentWarnings(agent.frontmatter) },
    status,
  );
}

/** The agent as a markdown file download (§6.3), named after its slug. */
export function exportResponse(c: Context, agent: AgentRecord) {
  const file = serializeAgentFile({ frontmatter: agent.frontmatter, prompt: agent.prompt });
  return c.body(file, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": `attachment; filename="${agent.slug}.md"`,
    "x-content-type-options": "nosniff",
    etag: etag(agent),
  });
}

export function invalidRequest(c: Context, message = "Check the request and try again.") {
  return c.json({ code: "invalid_request", message }, 400);
}

export function invalidAgent(c: Context, issues: readonly AgentFileIssue[]) {
  return c.json(
    { code: "invalid_agent", message: "The agent definition is not valid.", issues },
    400,
  );
}

export const notFound = (c: Context) =>
  c.json({ code: "agent_not_found", message: "No such agent." }, 404);

export const forbidden = (c: Context, message = "You can't change this agent.") =>
  c.json({ code: "forbidden", message }, 403);

export const archivedConflict = (c: Context) =>
  c.json(
    { code: "agent_archived", message: "This agent is archived. Unarchive it to change it." },
    409,
  );

/** A version without its content: who published it, when, and from what (D19 history). */
export function versionSummary(v: AgentVersionSummary) {
  return {
    version: v.version,
    publishedBy: v.publishedBy,
    publishedAt: v.publishedAt.toISOString(),
    draftRevision: v.draftRevision,
    republishedFrom: v.republishedFrom,
  };
}

/** A version with its frozen definition and tool manifest (callers that may read definitions). */
export function versionDetail(v: AgentVersionRecord) {
  return {
    ...versionSummary(v),
    frontmatter: v.definition.frontmatter,
    prompt: v.definition.prompt,
    toolManifest: v.toolManifest,
  };
}

const PUBLISH_ERRORS = {
  not_found: [404, "agent_not_found", "No such agent."],
  revision_mismatch: [
    412,
    "revision_mismatch",
    "Someone else changed this agent. Reload it and review the draft before publishing.",
  ],
  archived: [409, "agent_archived", "This agent is archived. Unarchive it to publish."],
  version_not_found: [404, "version_not_found", "This agent has no such version."],
  already_current: [409, "already_current", "That version is already the current one."],
  unchanged: [
    409,
    "unchanged",
    "Nothing to publish: the draft (and its tool manifest) equals the current version.",
  ],
  version_limit: [
    409,
    "version_limit_reached",
    "This agent has reached its version limit. Fork it to keep publishing.",
  ],
  invalid_draft: [
    409,
    "invalid_draft",
    "The draft is no longer a valid agent definition. Save a corrected draft first.",
  ],
} as const satisfies Record<PublishError, readonly [number, string, string]>;

export function publishError(c: Context, error: PublishError) {
  const [status, code, message] = PUBLISH_ERRORS[error];
  return c.json({ code, message }, status);
}

export const preconditionFailed = (c: Context) =>
  c.json(
    {
      code: "revision_mismatch",
      message: "Someone else changed this agent. Reload it and try again.",
    },
    412,
  );

const CREATE_ERRORS = {
  slug_taken: [409, "An agent with that slug already exists here."],
  limit_reached: [409, "This scope has reached its agent limit. Delete an agent first."],
} as const satisfies Record<CreateError, readonly [number, string]>;

export function createError(c: Context, error: CreateError) {
  const [status, message] = CREATE_ERRORS[error];
  return c.json({ code: error, message }, status);
}

export function agentDefinitionOf(agent: AgentRecord): AgentDefinition {
  return { frontmatter: agent.frontmatter, prompt: agent.prompt };
}
