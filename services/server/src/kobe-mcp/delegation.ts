import type { Context } from "hono";

/**
 * A delegated principal (KOBE-619, spec kobe-admin-mcp §3, KA1): "this person, in this run", with
 * which the Kobe MCP executor calls a console route in process. `requireSession` accepts it in
 * place of a session and `requireTeam` uses its team; every permission middleware and handler then
 * runs unchanged, so a tool can do nothing the route would refuse the person in the browser.
 *
 * Unforgeable by construction:
 * - it travels only in the Hono `env` of an in-process `app.request(...)`, under a module-private
 *   `Symbol` (not `Symbol.for`, so no other code can name the key). Over the network the Node
 *   adapter's `env` is `{incoming, outgoing}`: no header, cookie, query or body can put a symbol
 *   key there;
 * - the value must also be an object this module minted ({@link delegationEnv}) and froze: a
 *   look-alike object under a stolen key is ignored.
 * The executor mints one only after the server decided the call `allow` for exactly this run, tool
 * call and input (`kobe-mcp/service.ts`).
 */
export interface Delegation {
  /** The run's user: the thread's owner and the sandbox token's user. */
  readonly userId: string;
  /** The run's team; a delegated request can act on no other team. */
  readonly teamId: string;
  readonly runId: string;
  readonly threadId: string;
  /** The model's tool call id (audit `via`). */
  readonly toolCallId: string;
}

const DELEGATION = Symbol("kobe.delegation");
const minted = new WeakSet<object>();

/** The `env` for an in-process request on behalf of `delegation` (the executor only). */
export function delegationEnv(delegation: Delegation): Record<symbol, unknown> {
  const frozen: Delegation = Object.freeze({
    userId: delegation.userId,
    teamId: delegation.teamId,
    runId: delegation.runId,
    threadId: delegation.threadId,
    toolCallId: delegation.toolCallId,
  });
  minted.add(frozen);
  return { [DELEGATION]: frozen };
}

/** The request's delegation, when it is an in-process call the executor made; else undefined. */
export function delegationOf(c: Context): Delegation | undefined {
  const env: unknown = c.env;
  if (typeof env !== "object" || env === null) return undefined;
  const value = (env as Record<symbol, unknown>)[DELEGATION];
  if (typeof value !== "object" || value === null || !minted.has(value)) return undefined;
  return value as Delegation;
}

/** The session id a delegated request carries: matches no Better Auth session row. */
export const DELEGATED_SESSION_PREFIX = "kobe-delegation:";
