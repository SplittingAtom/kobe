# KOBE-128: kobe-tools Pi extension (create_artifact / update_artifact)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in progress (PR pending)
- **Branch / worktree:** `kobe-128-sandbox-kobe-tools` in `../Kobe-wt128`
- **Depends on:** KOBE-127 (PR #102, contract; this branch is stacked on it, merge `origin/main` once it lands)
- **Binding design:** [KOBE-55.md](KOBE-55.md) D-1, D-2, D-4

## Plan

1. Extension `services/sandbox-agent/src/kobe-tools/` (self-contained like kobe-policy: node builtins
   and own files only): `protocol.ts` (constants mirroring `packages/protocol/src/artifacts.ts`,
   pinned by a test), `client.ts` (fd-4 JSONL client, 30 s timeout, fail closed), `tools.ts` (the two
   tool definitions), `frame-size.ts`, `extension.ts`, `index.ts`.
2. Agent side `src/tools/`: `channel.ts` (validates with `kobeToolsRequestSchema`), `broker.ts`
   (`artifact.put` out, `artifact.result` back; mints `request_id`, adds `run_id`/`thread_id`).
3. Wiring: `pi-launch.ts` (fd 4 + `KOBE_TOOLS_FD`, extension right before kobe-policy),
   `pi-process.ts` (fifth stdio pipe), `thread.ts`/`manager.ts`/`agent.ts`, config
   `KOBE_TOOLS_EXTENSION` (optional), hello capability `artifacts`.
4. Image: `Dockerfile` (root-owned 0444 files in 0555 dir, `ENV KOBE_TOOLS_EXTENSION`),
   `kobe-runas.c` (passes fd 4), `test-image.sh`.

## Decisions

- **The capability follows the config.** The agent announces `artifacts` exactly when
  `KOBE_TOOLS_EXTENSION` is set (the image sets it); then Pi gets fd 4. Unset (old image, dev): no
  fd 4, no tools, no capability. An extension that finds no `KOBE_TOOLS_FD` registers nothing, so
  the model is never offered a tool that cannot work. A set-but-bad file (not root-owned) fails
  agent startup, like kobe-policy.
- **Plain JSON Schema for tool parameters**, not TypeBox: keeps the extension free of imports
  beyond node builtins; real Pi 1.0.0 accepts it (real-Pi test). Server stays the validator (D-1).
- **No nonce / hello on fd 4** (the contract defines none). Trust rests on the same grounds as fd 3
  (only this Pi has the fd) plus D-3: the server re-checks every `artifact.put` against what it
  allowed. The agent never takes `run_id`/`thread_id` from the extension (strict schema).
- **1 MiB check** in `frame-size.ts`: builds the `policy.check` and `artifact.put` frames with
  worst-case ids and measures them (JSON escaping can make 512 KiB of content exceed 1 MiB). The
  agent broker re-checks the `artifact.put` frame it actually builds (`too_large`).
  In practice kobe-policy denies such a call first (its own 1 MiB check); the extension's check is
  the defence in depth the ticket asks for and is unit-tested.
- **Per-thread cap of 8 in-flight puts** (64 per sandbox); beyond it the tool errors.
- **`kobe-runas` now keeps fd 4** (`close_range` from 5). Without this, under Pi identities
  (KOBE-71) the extension would find no channel.
- **Later ops** (`share_file` KOBE-54, `remember` KOBE-56): add an `op` to `protocol.ts` `OPS`, a
  request variant in the protocol's `kobeToolsRequestSchema`, a tool in `kobe-tools/`, and a broker
  case in `src/tools/`. Nothing of them is implemented.

## Open questions (for Chris or the coordinator)

- `test-image.sh` checks (extension perms, fd-4 round trip through real Pi, runas fd pass-through)
  were not run here (no Docker engine); the fd-4 probe script itself was run against the local real
  Pi (both modes). CI's image job is the first full run.
- Server-side (KOBE-129) must record the allowed input hash per `tool_call_id` before this works end
  to end; this ticket only needs the contract frames.

## Evidence (acceptance criteria → test or command output)

- ac-1 (Pi lists both tools; policy first, then `artifact.put`):
  `src/kobe-tools.real-pi.test.ts` (real Pi + real kobe-policy; no `artifact.put` before allow);
  unit: `kobe-tools/extension.test.ts`.
- ac-2 (result carries `artifact_id` + `version`; server errors become tool errors):
  `kobe-tools.real-pi.test.ts` ("returns artifact_id and version", "turns a server error into a
  tool error"), `kobe-tools/tools.test.ts`, `tools/broker.test.ts`.
- ac-3 (image: root-owned read-only; fails closed without capability): `images/sandbox/test-image.sh`
  (kobe-tools extension perms, baked-file check, fd-4 round trip, "without fd 4 no artifact tool");
  real-Pi test "offers no artifact tools to a Pi started without the extension". The server-side
  refusal of `artifact.put` without the capability is KOBE-129 (D-2).
- Timeout, closed channel, oversize/malformed reply: `kobe-tools/client.test.ts`;
  agent channel limits: `tools/channel.test.ts`.
