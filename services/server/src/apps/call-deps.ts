import type { ServerDeps } from "../deps.js";
import { DENIED_AUDIT_RATE } from "../mcp/service.js";
import { createDbRuleSource } from "../policy/rule-store.js";
import { createRateLimiter } from "../sandbox/rate-limit.js";
import type { AppCallDeps } from "./call.js";
import { createValidatorPool, type SchemaValidator } from "./validate-pool.js";

/** Per member: a burst of 30 app calls, then 5 per second (spec T10). */
export const APP_CALL_RATE = { capacity: 30, refillPerSecond: 5 } as const;

const shared = new WeakMap<ServerDeps, AppCallDeps>();

/**
 * One set of app-call dependencies per server (KOBE-436, KOBE-440): the apps' own calls and the
 * rail's launches share the member's rate limit, the validator pool and the audit throttles.
 */
export function appCallDepsFor(deps: ServerDeps): AppCallDeps {
  const known = shared.get(deps);
  if (known) return known;
  const db = deps.database.db;
  // Workers start on the first call, not for every app instance (tests build many).
  let pool: SchemaValidator | undefined;
  const validator: SchemaValidator = {
    validate: (schema, instance, owner) =>
      (pool ??= createValidatorPool()).validate(schema, instance, owner),
    close: async () => pool?.close(),
  };
  const callDeps: AppCallDeps = {
    db,
    mcp: deps.mcp,
    rules: createDbRuleSource(db),
    caller: deps.appCaller,
    validator,
    limiter: createRateLimiter(APP_CALL_RATE),
    limitedAudits: createRateLimiter({ capacity: 1, refillPerSecond: 1 / 60 }),
    deniedAudits: createRateLimiter(DENIED_AUDIT_RATE),
  };
  shared.set(deps, callDeps);
  return callDeps;
}
