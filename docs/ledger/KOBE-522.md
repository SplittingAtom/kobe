# KOBE-522: Sandbox agent re-trades its session grant on a 401 (rate-limited)

- **Status:** in review (group branch `group-hardening-3`, one PR for the group)
- **Branch / worktree:** `group-hardening-3` in `../Kobe-g-hardening-3`
- **Depends on:** KOBE-513 (Ed25519 session tokens, merged in #408)

## Plan

After a signing-key change (the KOBE-513 upgrade, or a rotation done without the three steps) a
running sandbox kept presenting its cached tokens until the session client's scheduled re-trade
(2 min before expiry: up to ~13 min). Fix in the sandbox agent: a refused token drops the cached
grant and trades the bootstrap token again (that trade does not depend on session keys), and the
new grant reaches every token consumer at once.

## Decisions

- `SessionClient.rejected(audience, reason, token?)` (`services/sandbox-agent/src/session/exchange.ts`)
  drops the grant and starts one trade; returns whether it did. A rejection of a token that was
  already replaced, or one arriving while a trade is in flight, is ignored.
- Rate limit (`RETRADE_BACKOFF`): one re-trade per 30 s, the gap doubling to 5 min while the
  server keeps refusing; a rejection 10 min or more after the last re-trade starts over at 30 s.
  Each re-trade logs at info (`sandbox session re-trade after a rejected token`, audience,
  reason, streak, next allowed gap); the first rejection held back in a window logs one warn
  (`sandbox session re-trade rate-limited`). Tokens are never logged.
- `SessionClient.onGrant(listener)`: every new grant (scheduled or after a rejection) is
  announced; `index.ts` subscribes the model, MCP and egress `ModelTokenKeeper`s, which call the
  new `refresh()` and hand the tokens to their listeners (threads rewrite Pi's model, MCP and
  egress files). One rejection therefore renews all four audiences.
- The wire is the detector: `WireClient` reports the dialled token via `onTokenRejected` on an
  HTTP 401 upgrade answer (`unexpected-response`) and on close 4001 (`unauthorized`); the next
  dial reads the re-traded token. A key change on upgrade restarts the server, so the wire
  reconnect sees the refusal within its first redial.
- Security review item 1 (2026-10-29): detection stays **wire-only**; docstring, `index.ts`
  comment, install.md and this ledger say so. No cheap, reliable hook exists: Pi and its tools
  call the gateway and proxies directly; the agent sees no proxy/egress status at all, and a
  model 401 reaches it only as an opaque Pi event error after Pi's own re-read (a model-only
  sniffer would leave MCP and egress uncovered). Residual window, documented plainly: from a
  verifier's restart with new keys until the sandbox's wire reconnects to an upgraded server pod
  (rolling upgrades can restart the verifiers first), model/MCP/egress calls are refused.
- Review item 2: a re-trade skips the 30 s fast-retry phase and every refusal moves along the
  backoff (250 ms → 30 s), so a refused bootstrap token no longer costs ~150 POSTs per re-trade.
- Review item 3: a throwing grant listener is logged at warn; the grant still resolves.
- Review item 4: non-401 upgrade refusals log their HTTP status at debug.
- `sessionTokenKeeper()` (`session/keepers.ts`) builds the model/MCP/egress keepers and their
  `onGrant` subscription, so the `index.ts` wiring is tested.
- Docs: `docs/install.md` "Session-token keys" gains "Running sandboxes and a key change"; the
  KOBE-513 upgrade note is relaxed but keeps the caveat that pods started from a pre-KOBE-522
  image keep the old agent until they restart (so upgrading _from_ such a release still wants no
  active runs).

## Open questions (for Chris or the coordinator)

- Wire-only detection leaves the window above (verifiers ahead of the server in a rolling
  upgrade, or a verifier-only key change, until the scheduled re-trade). A follow-up could have
  the kobe-models extension and the tools report gateway/proxy 401s to the agent, or the chart
  could roll the server before the verifiers.

## Evidence (acceptance criteria → test or command output)

- **ac-1** (one re-trade within seconds; recovery without a restart):
  `src/session/exchange.test.ts` "drops the cached grant and trades the bootstrap token again at
  once, telling listeners"; `src/wire/client.reject.test.ts` "reports a 401 on the upgrade with
  the refused token, then dials with the next token", "reports a 4001 close of a live connection
  and reconnects with the next token", "recovers through the session client's bootstrap
  re-trade, without a restart" (real `SessionClient` + `WireClient`, the model-gateway token
  listener gets the new token); `src/models/token-keeper.test.ts` "refresh() picks up a grant
  the session re-traded for another audience's rejection"; `src/session/keepers.test.ts` "hands
  the MCP and egress keepers the re-traded tokens after a wire rejection".
- Negative: `src/wire/client.reject.test.ts` "does not report a network drop (1006) or a 503
  upgrade answer as a refused token".
- **ac-2** (rate-limited, logged, no hot loop): `src/session/exchange.test.ts` "re-trades at most
  once per 30 s and warns once when the limit holds one back", "backs off exponentially to 5 min
  while the server keeps refusing, so it never loops hot" (a rejection every second for an hour:
  gaps 30/60/120/240/300 s, ≤ 20 trades), "starts the backoff over once a grant has been quiet
  for 10 min", "ignores a rejection of a token that was already replaced", "goes straight to the
  backoff schedule while the server refuses a re-trade (no fast retries)", "keeps the new grant
  when a listener throws".
- `pnpm verify`: see the commit.
