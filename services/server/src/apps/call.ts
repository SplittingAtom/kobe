import { withTeam, type AppCallReason, type KobeDb } from "@kobe/db";
import { toolInputSchema, type JsonObject } from "@kobe/protocol";
import { recordAudit } from "../audit/record.js";
import { logger } from "../logger.js";
import type { McpService } from "../mcp/service.js";
import type { PolicyRuleSource } from "../policy/engine.js";
import type { RateLimiter } from "../sandbox/rate-limit.js";
import type { AppCaller } from "./app-caller.js";
import { appConnectorOf, memberApp, type MemberApp } from "./catalog.js";
import { appBridgeDecision, checkAppTool, validateArguments } from "./decide.js";

/**
 * An MCP App's own `tools/call` under the viewing member's browser principal (KOBE-436, spec §6):
 * `{kind: browser, userId, teamId}` from the session and the active team, with no thread and no
 * run, so it can never obtain an approval. Checked in order, failing closed, with one
 * `mcp.app_call` audit row per decision (allowed rows before the call is forwarded):
 *
 * 0. a per-member rate limit (burst 30, then 5 per second);
 * 1. the app is live for the member (MA8) and the tool is of the app's connector;
 * 2. the tool is pinned, read-only, app-visible and in the team's exposure;
 * 3. the arguments are a JSON object of at most 64 KiB valid against the pinned schema;
 * 4. policy at `app_bridge` (MA5): deny rules, ask → deny, read only; no user rule widens it;
 * 5. the member's credential is revealed (grant or site key, the full liveness chain);
 * 6. mcp-proxy calls the upstream; the result goes back as is.
 *
 * Nothing about the credential reaches the browser, a log line, an audit row or an event.
 */
export interface AppCallDeps {
  readonly db: KobeDb;
  readonly mcp: Pick<McpService, "revealForMember">;
  readonly rules: PolicyRuleSource;
  readonly caller: AppCaller;
  readonly limiter: RateLimiter;
  /** Throttles the audit of rate-limited refusals (one per member per window). */
  readonly limitedAudits: RateLimiter;
  readonly now?: () => Date;
}

export interface BrowserPrincipal {
  readonly kind: "browser";
  readonly userId: string;
  readonly teamId: string;
}

export type AppCallOutcome =
  | { readonly ok: true; readonly result: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly status: 403 | 404 | 422 | 429 | 502;
      readonly code: AppCallReason;
      readonly message: string;
    };

const MESSAGES: Readonly<Record<AppCallReason, string>> = {
  allowed: "",
  app_not_available: "This app is not available to you in this team.",
  tool_not_in_app: "This app cannot call that tool.",
  tool_drifted: "That tool changed and is waiting for a site admin's review.",
  tool_not_read_only: "Apps may call only read-only tools.",
  tool_not_app_visible: "That tool is not offered to apps.",
  connector_exposure: "Your team does not expose that tool.",
  invalid_arguments: "The tool's arguments are not valid.",
  site_deny_rule: "Site policy blocks that tool.",
  team_deny_rule: "Team policy blocks that tool.",
  app_no_prompt: "That tool needs an approval, and apps cannot ask for one.",
  app_read_only: "Apps may call only read-only tools.",
  not_connected: "Connect your account for this connector first.",
  credential_unavailable: "Your connector credentials are unavailable right now. Try again.",
  rate_limited: "Too many calls from this app. Wait a moment.",
  upstream_failed: "The connector's server did not answer the call.",
};

const STATUS: Readonly<Record<AppCallReason, 403 | 404 | 422 | 429 | 502>> = {
  allowed: 403,
  app_not_available: 404,
  tool_not_in_app: 403,
  tool_drifted: 403,
  tool_not_read_only: 403,
  tool_not_app_visible: 403,
  connector_exposure: 403,
  invalid_arguments: 422,
  site_deny_rule: 403,
  team_deny_rule: 403,
  app_no_prompt: 403,
  app_read_only: 403,
  not_connected: 403,
  credential_unavailable: 502,
  rate_limited: 429,
  upstream_failed: 502,
};

const refused = (code: AppCallReason): AppCallOutcome => ({
  ok: false,
  status: STATUS[code],
  code,
  message: MESSAGES[code],
});

interface Audited {
  readonly connectorId: string;
  readonly tool: string;
  readonly templateSha256?: string | undefined;
}

async function audit(
  db: KobeDb,
  p: BrowserPrincipal,
  audited: Audited,
  reason: AppCallReason,
): Promise<void> {
  // The tool name is recorded only when it is a plausible MCP name (it comes from the app).
  const what = {
    ...audited,
    tool: /^[A-Za-z0-9_.-]{1,128}$/.test(audited.tool) ? audited.tool : "invalid",
  };
  await withTeam(db, p.teamId, (tx) =>
    recordAudit(tx, {
      action: "mcp.app_call",
      teamId: p.teamId,
      actor: { kind: "user", id: p.userId },
      target: {
        connectorId: what.connectorId,
        userId: p.userId,
        tool: what.tool,
        decision: reason === "allowed" ? "allowed" : "denied",
        reason,
        ...(what.templateSha256 === undefined ? {} : { templateSha256: what.templateSha256 }),
      },
    }),
  );
}

/** An audited refusal. */
async function deny(
  deps: AppCallDeps,
  p: BrowserPrincipal,
  what: Audited,
  reason: AppCallReason,
): Promise<AppCallOutcome> {
  await audit(deps.db, p, what, reason);
  return refused(reason);
}

/** Steps 1-4: the decision, without any credential. */
async function decide(
  deps: AppCallDeps,
  p: BrowserPrincipal,
  app: MemberApp,
  toolName: string,
  args: unknown,
  now: Date,
): Promise<{ ok: true; args: JsonObject } | { ok: false; reason: AppCallReason }> {
  const checked = checkAppTool(app.connector, toolName);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  const input = toolInputSchema.safeParse(args ?? {});
  if (!input.success || !validateArguments(checked.tool, input.data)) {
    return { ok: false, reason: "invalid_arguments" };
  }
  const rules = await deps.rules.load(p.teamId, p.userId, now);
  const bridge = appBridgeDecision(app.connector.id, checked.tool, input.data, rules, now);
  return bridge.allowed ? { ok: true, args: input.data } : { ok: false, reason: bridge.reason };
}

export async function callApp(
  deps: AppCallDeps,
  p: BrowserPrincipal,
  appId: string,
  request: { readonly tool: string; readonly arguments?: unknown },
): Promise<AppCallOutcome> {
  const now = deps.now?.() ?? new Date();
  const member = `${p.teamId}:${p.userId}`;
  if (deps.limiter.take(member) !== 0) {
    const connectorId = await appConnectorOf(deps.db, appId);
    if (connectorId && deps.limitedAudits.take(member) === 0) {
      await audit(deps.db, p, { connectorId, tool: request.tool }, "rate_limited");
    }
    return refused("rate_limited");
  }
  const app = await memberApp(deps.db, p.teamId, p.userId, appId);
  if (!app) {
    // Not live for this member (connector not enabled, no key, drifted template, ...): audited
    // against the connector when the id names a real app; an unknown id has nothing to name.
    const connectorId = await appConnectorOf(deps.db, appId);
    if (connectorId) return deny(deps, p, { connectorId, tool: request.tool }, "app_not_available");
    return refused("app_not_available");
  }
  const what = { connectorId: app.connector.id, tool: request.tool, templateSha256: app.sha256 };
  const decided = await decide(deps, p, app, request.tool, request.arguments, now);
  if (!decided.ok) return deny(deps, p, what, decided.reason);

  let credential: Parameters<AppCaller["call"]>[0]["credential"];
  if (app.connector.authKind !== "none") {
    const revealed = await deps.mcp.revealForMember(p.teamId, p.userId, app.connector.id);
    if (!revealed.ok) {
      const reason =
        revealed.failure === "unavailable" ? "credential_unavailable" : "not_connected";
      return deny(deps, p, what, reason);
    }
    credential = revealed.credential;
  }
  await audit(deps.db, p, what, "allowed");
  const answer = await deps.caller.call({
    connectorId: app.connector.id,
    url: app.connector.url,
    tool: request.tool,
    arguments: decided.args,
    ...(credential === undefined ? {} : { credential }),
  });
  if (answer.ok) return { ok: true, result: answer.result };
  logger.info(
    { connectorId: app.connector.id, tool: request.tool, failure: answer.failure },
    "app call failed upstream",
  );
  return refused("upstream_failed");
}
