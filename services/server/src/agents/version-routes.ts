import type { Context, Hono } from "hono";
import type { KobeDb } from "@kobe/db";
import type { AgentAccess } from "./access.js";
import {
  agentDetail,
  agentResponse,
  etag,
  forbidden,
  ifMatchRevision,
  invalidRequest,
  notFound,
  publishError,
  versionDetail,
  versionSummary,
} from "./http.js";
import {
  rollbackSchema,
  VERSION_PAGE_DEFAULT,
  versionParamSchema,
  versionsQuerySchema,
} from "./schemas.js";
import type { AgentLocation, AgentRecord } from "./store.js";
import {
  getVersion,
  listVersions,
  publishAgent,
  rollbackAgent,
  unarchiveAgent,
  UnreadableVersionError,
  type Published,
} from "./versions.js";
import type { AgentLimits } from "../deps.js";
import { logger } from "../logger.js";
import { hitRateLimit } from "../rate-limit.js";
import { parseBody } from "../teams/http.js";
import { agentWarnings } from "@kobe/agent-file";

/**
 * Runs `fn`; a stored version whose manifest doesn't parse answers 500 `version_unreadable` (fail
 * closed, logged with the agent and version for operators) instead of a bare 500.
 */
async function guardUnreadable(c: Context, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof UnreadableVersionError)) throw err;
    logger.error({ agentId: err.agentId, version: err.version }, err.message);
    return c.json(
      { code: err.code, message: "This agent version can't be read. Ask an administrator." },
      500,
    );
  }
}

/** An agent the caller may see, where it lives, and what the caller may do with it. */
export interface ResolvedAgent {
  readonly agent: AgentRecord;
  readonly location: AgentLocation;
  readonly access: AgentAccess;
}

export interface VersionRouteOptions {
  readonly db: KobeDb;
  readonly limits: AgentLimits;
  /** The agent named by `:id` if the caller may see it; null → 404 (no existence oracle). */
  readonly resolve: (c: Context) => Promise<ResolvedAgent | null>;
  /** The signed-in user publishing (recorded on the version). */
  readonly userId: (c: Context) => string;
}

/** Gallery versions: curators' user ids are for install admins only (review L3). */
function redact<T extends { publishedBy: string | null }>(found: ResolvedAgent, version: T): T {
  return found.agent.scope === "gallery" && !found.access.edit
    ? { ...version, publishedBy: null }
    : version;
}

function publishedResponse(c: Context, published: Published, access: AgentAccess) {
  c.header("ETag", etag(published.agent));
  return c.json(
    {
      agent: agentDetail(published.agent, access),
      version: versionDetail(published.version),
      warnings: agentWarnings(published.agent.frontmatter),
    },
    201,
  );
}

/**
 * Versions, publish, rollback and unarchive (spec D19, §6.1 `/v1/agents/{id}/versions`,
 * `POST /v1/agents/{id}/publish`), mounted on the team router and the gallery router alike;
 * each passes its own `resolve` (visibility and rights).
 */
export function mountVersionRoutes<E extends { Variables: object }>(
  app: Hono<E>,
  options: VersionRouteOptions,
): void {
  const { db, resolve, limits } = options;

  /** Publishes and rollbacks share one per-user budget (review M3); false → 429. */
  const withinRate = (c: Context) =>
    hitRateLimit(db, `agent-publish:${options.userId(c)}`, limits.publishRate);
  const rateLimited = (c: Context) =>
    c.json(
      { code: "rate_limited", message: "Too many publishes. Wait a few minutes and try again." },
      429,
    );

  app.get("/:id/versions", async (c) => {
    const found = await resolve(c);
    if (!found) return notFound(c);
    const query = versionsQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalidRequest(c, "before is a version number; limit is 1–200.");
    const limit = query.data.limit ?? VERSION_PAGE_DEFAULT;
    const versions = await listVersions(db, found.location, found.agent.id, {
      before: query.data.before,
      limit: limit + 1,
    });
    if (!versions) return notFound(c);
    const page = versions.slice(0, limit);
    return c.json({
      currentVersion: found.agent.currentVersion,
      versions: page.map((v) => redact(found, versionSummary(v))),
      nextBefore: versions.length > limit ? (page.at(-1)?.version ?? null) : null,
    });
  });

  app.get("/:id/versions/:version", async (c) => {
    const found = await resolve(c);
    if (!found) return notFound(c);
    const version = versionParamSchema.safeParse(c.req.param("version"));
    if (!version.success) return invalidRequest(c, "The version must be a positive number.");
    if (!found.access.readDefinition) {
      return forbidden(c, "Your team role doesn't allow reading team agent definitions.");
    }
    return guardUnreadable(c, async () => {
      const record = await getVersion(db, found.location, found.agent.id, version.data);
      if (!record) return publishError(c, "version_not_found");
      return c.json({ version: redact(found, versionDetail(record)) });
    });
  });

  app.post("/:id/publish", async (c) => {
    const found = await resolve(c);
    if (!found) return notFound(c);
    if (!found.access.publish) return forbidden(c, "Your team role doesn't allow publishing it.");
    const ifMatch = ifMatchRevision(c);
    if (!ifMatch.ok) return ifMatch.response;
    if (!(await withinRate(c))) return rateLimited(c);
    const result = await publishAgent(db, found.location, found.agent.id, {
      publishedBy: options.userId(c),
      expectedRevision: ifMatch.revision,
      limits,
    });
    return result.ok
      ? publishedResponse(c, result.value, found.access)
      : publishError(c, result.error);
  });

  app.post("/:id/rollback", async (c) => {
    const found = await resolve(c);
    if (!found) return notFound(c);
    const body = await parseBody(c, rollbackSchema);
    if (!body) return invalidRequest(c, "Give the version to roll back to.");
    if (!found.access.publish) return forbidden(c, "Your team role doesn't allow publishing it.");
    if (!(await withinRate(c))) return rateLimited(c);
    return guardUnreadable(c, async () => {
      const result = await rollbackAgent(db, found.location, found.agent.id, {
        publishedBy: options.userId(c),
        fromVersion: body.version,
        limits,
      });
      return result.ok
        ? publishedResponse(c, result.value, found.access)
        : publishError(c, result.error);
    });
  });

  app.post("/:id/unarchive", async (c) => {
    const found = await resolve(c);
    if (!found) return notFound(c);
    if (!found.access.edit) return forbidden(c);
    const agent = await unarchiveAgent(db, found.location, found.agent.id);
    return agent ? agentResponse(c, agent, found.access) : notFound(c);
  });
}
