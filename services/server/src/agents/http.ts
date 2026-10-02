import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  AGENT_FILE_LIMITS,
  parseAgentFile,
  serializeAgentFile,
  validateAgentDefinition,
  type AgentDefinition,
  type AgentFileIssue,
} from "@kobe/agent-file";
import type { AgentAccess } from "./access.js";
import type { AgentRecord, CreateError } from "./store.js";

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
  | { ok: true; definition: AgentDefinition; meta: Record<string, unknown> }
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
    return { ok: true, definition: result.definition, meta: c.req.query() };
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
  return { ok: true, definition: result.definition, meta };
}

/** Parses `If-Match` into an expected draft revision; `*` or absent means "any". */
export function readIfMatch(c: Context): { ok: true; revision?: number } | { ok: false } {
  const header = c.req.header("if-match")?.trim();
  if (header === undefined || header === "*") return { ok: true };
  const match = /^(?:W\/)?"(\d{1,9})"$/.exec(header);
  return match?.[1] ? { ok: true, revision: Number(match[1]) } : { ok: false };
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
  return c.json({ agent: agentDetail(agent, access) }, status);
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
