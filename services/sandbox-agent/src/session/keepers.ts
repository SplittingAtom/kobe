import type { SessionTokenAudience } from "@kobe/protocol";
import { ModelTokenKeeper } from "../models/token-keeper.js";
import type { SessionClient } from "./exchange.js";

/**
 * A rotating token keeper for one audience of the session grant (model gateway, MCP proxy, egress
 * proxy). It also follows every new grant (KOBE-522): after a re-trade for a rejected wire token,
 * this audience's token changed too, and Pi's files get it at once rather than at the next
 * scheduled trade.
 */
export function sessionTokenKeeper(
  session: SessionClient,
  audience: Exclude<SessionTokenAudience, "kobe.sandbox-wire">,
  logger: { warn(obj: object, msg: string): void },
): ModelTokenKeeper {
  const keeper = new ModelTokenKeeper({
    grant: async () => {
      const g = await session.grant();
      return { token: g.tokens[audience], expiresAt: g.expiresAt };
    },
    refreshMarginMs: session.refreshMarginMs,
    logger,
  });
  session.onGrant(() => void keeper.refresh().catch(() => undefined));
  return keeper;
}
