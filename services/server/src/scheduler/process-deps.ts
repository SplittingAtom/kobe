import { randomBytes } from "node:crypto";
import type { Mailer } from "../mail/mailer.js";
import type { ServerDepsOptions } from "../deps.js";

/**
 * The scheduler process (KOBE-174) builds the same run orchestrator and sandbox wire router as the
 * server, but serves no user API and sends no email: it is given none of the server's auth
 * secrets. `createServerDeps` still wants them, so it gets values that exist only in this
 * process's memory (nothing can sign in to it, and no cookie or setup link it makes is usable).
 */
export const disabledMailer: Mailer = {
  send: () => Promise.reject(new Error("the scheduler process does not send email")),
  close: () => undefined,
};

export function schedulerAuthStandIn(): Pick<
  ServerDepsOptions,
  "publicUrl" | "authSecret" | "setupToken" | "trustedProxies" | "mailer"
> {
  return {
    publicUrl: "http://scheduler.invalid",
    authSecret: randomBytes(32).toString("hex"),
    setupToken: randomBytes(32).toString("hex"),
    trustedProxies: [],
    mailer: disabledMailer,
  };
}
