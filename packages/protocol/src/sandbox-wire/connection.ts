/**
 * Sandbox ↔ server connection contract (D13). Consumers: KOBE-23 (kobe-sandbox-agent), KOBE-24
 * (server registry and routing), KOBE-36 (kobe-policy), KOBE-41 (model wiring), KOBE-62 (MCP wiring).
 *
 * Transport
 * - The sandbox dials out; sandboxes accept no inbound connections. One WebSocket per sandbox
 *   process, `wss://<server-internal-host>` + {@link SANDBOX_WS_PATH} (in-cluster TLS or a service-
 *   mesh hop is a deployment concern; the path is the contract).
 * - Auth: the sandbox's session token for audience `kobe.sandbox-wire` (session-token.ts) in
 *   `Authorization: Bearer <token>` on the upgrade request (never in the URL: URLs end up in logs).
 *   Tokens are audience-bound: the Bifrost / MCP-proxy / egress tokens are different tokens and are
 *   rejected here. The server derives (team_id, user_id, sandbox_id) from the token;
 *   `hello.sandbox_id` must equal `sub` or the server closes with `unauthorized`.
 * - Subprotocol: `Sec-WebSocket-Protocol: kobe.sandbox.v1`. Text frames only, one JSON object per
 *   frame, at most {@link SANDBOX_MAX_FRAME_BYTES} UTF-8 bytes. Every frame has `v` and `type`.
 *   The cap is enforced at the WebSocket layer too (e.g. `ws` `maxPayload`, KOBE-23/24) so an
 *   oversize frame is never buffered whole; `decode*Frame` re-checks.
 * - Per-type caps, sandbox → server ({@link SANDBOX_FRAME_MAX_BYTES_BY_TYPE}): only `pi.event` and
 *   `command.result` may use the full 4 MiB, `policy.check` at most 1 MiB (it carries a `write`'s
 *   content as executed), `artifact.put` at most 1 MiB (artifacts.ts), every other frame at most
 *   {@link SANDBOX_SMALL_FRAME_MAX_BYTES}. The
 *   server reads the type from the raw frame before decoding, so **a frame larger than
 *   {@link SANDBOX_SMALL_FRAME_MAX_BYTES} must start with `v` then `type`** — `{"v":1,"type":"…"`,
 *   those two keys first, within the first 64 bytes (insignificant whitespace allowed). A frame
 *   over its type's cap, or a large frame whose type can't be read that way, closes the connection
 *   with `protocol_error`.
 * - Inbound frames are parsed strictly (json-safety.ts): duplicate keys, U+0000 and `__proto__`
 *   keys make a frame malformed. kobe-sandbox-agent replaces U+0000 in Pi output with U+FFFD.
 *
 * Capabilities: `hello.capabilities` may list `artifacts` ({@link CAPABILITY_ARTIFACTS}, artifacts.ts):
 *   the agent then sends `artifact.put` and the server answers `artifact.result`. The server refuses
 *   `artifact.put` from a connection that did not announce it.
 *   It may also list `files` (`CAPABILITY_FILES`, files.ts, KOBE-147): the agent then registers `share_file`
 *   and, after pushing the file through workspace sync, sends `file.share` (a small frame: no own size
 *   entry in the table above); the server answers `file.share_result` and refuses `file.share` from a
 *   connection that did not announce the capability.
 *   `memory` ({@link CAPABILITY_MEMORY}, memory.ts): `memory.put` / `memory.read` / `memory.result` and
 *   `run.start.memory`; same refusal rule.
 *
 * Leasing (normative)
 * - The server leases each run and thread to exactly one authenticated connection: the one whose
 *   token's (team, user, sandbox) owns the run's thread, and to which the server sent `run.start`
 *   (or listed in `hello.ack`). Every inbound frame's `run_id` / `thread_id` must be leased to the
 *   connection it arrived on, and a `command.result`'s `command_id` must have been issued on that
 *   same connection (ids are not portable across reconnects; the server re-issues).
 * - A lease ends when its run goes terminal. A late frame for an ended run of this connection
 *   (benign race after Stop) gets `error` `run_not_active` and is not executed — a late
 *   `policy.check` is answered with `policy.result` `deny` as well, so kobe-policy unblocks.
 * - Anything else (a run/thread/command never leased to this connection) is a violation: `error`
 *   `unknown_run` / `unknown_thread`, frame dropped, connection closed with `lease_violation` (a
 *   sandbox naming another sandbox's run is compromised or broken).
 *
 * Delivery and resume
 * - Sandbox → server `pi.event` frames carry `run_id` and an outbound `seq` (per run, from 1,
 *   gapless, assigned by kobe-sandbox-agent). The agent keeps un-acked frames in memory.
 * - **Durable inbound cursor:** the server keeps the last accepted sandbox seq per run in
 *   **`runs.sandbox_seq`** (integer NOT NULL DEFAULT 0; added by KOBE-23/24). Accepting a
 *   `pi.event` with seq `s` is ONE transaction that starts with the compare-and-set
 *       UPDATE runs SET sandbox_seq = $s WHERE team_id = $t AND id = $r AND sandbox_seq = $s - 1
 *   which must affect exactly one row, then appends the resulting `run_events` / `thread_entries`
 *   rows (zero or more — Pi events and Kobe events are not 1:1, so `runs.last_seq` cannot stand in
 *   for this cursor), then commits. Zero rows means: `s <= sandbox_seq` → duplicate, drop it (still
 *   `ack`); `s > sandbox_seq + 1` → gap: drop it and send `resend` with
 *   `from_seq = sandbox_seq + 1` on the same live socket (don't wait for a reconnect); the agent
 *   re-sends from there in order and ignores further `resend`s for seqs it already re-sent. After
 *   commit the server sends `ack` (cumulative: "everything up to seq N of run R is durable").
 * - On reconnect `hello.runs` lists the agent's live runs and their highest sent seq; `hello.ack`
 *   returns `durable_seq` = `runs.sandbox_seq` per run; the agent re-sends everything after it. Runs the server does
 *   not list are aborted by the agent. Runs the agent does not list (Pi or agent restarted) are
 *   interrupted by the server (D14: never auto-retried).
 * - Server → sandbox commands are idempotent by `command_id`; the agent remembers recent ids and
 *   ignores duplicates. Every command gets exactly one `command.result`.
 * - Outbound `seq` is NOT the Kobe Event Stream `seq`; the server assigns that when it writes
 *   `run_events`.
 */

export const SANDBOX_WIRE_VERSION = 1;
export const SANDBOX_WS_PATH = "/v1/sandbox/connect";
export const SANDBOX_WS_SUBPROTOCOL = "kobe.sandbox.v1";

/** SPECULATIVE limits: tune in KOBE-23/24; changing them is not a wire break. */
export const SANDBOX_MAX_FRAME_BYTES = 4 * 1024 * 1024;
/** Cap for any sandbox → server frame type not listed in {@link SANDBOX_FRAME_MAX_BYTES_BY_TYPE}. */
export const SANDBOX_SMALL_FRAME_MAX_BYTES = 256 * 1024;
/** Sandbox → server frame types allowed above {@link SANDBOX_SMALL_FRAME_MAX_BYTES}. */
export const SANDBOX_FRAME_MAX_BYTES_BY_TYPE = {
  "pi.event": SANDBOX_MAX_FRAME_BYTES,
  "command.result": SANDBOX_MAX_FRAME_BYTES,
  "policy.check": 1024 * 1024,
  "artifact.put": 1024 * 1024, // KOBE-127: up to 512 KiB of content plus JSON escaping
} as const;
export const SANDBOX_HELLO_TIMEOUT_MS = 10_000;
export const SANDBOX_HEARTBEAT_INTERVAL_MS = 15_000;
export const SANDBOX_HEARTBEAT_TIMEOUT_MS = 45_000;

/** WebSocket close codes (4000–4999 is the application range). */
export const SANDBOX_CLOSE_CODES = {
  unauthorized: 4001,
  unsupported_version: 4002,
  replaced: 4003,
  sandbox_destroyed: 4004,
  hello_timeout: 4005,
  protocol_error: 4006,
  lease_violation: 4007,
  heartbeat_timeout: 4008,
  hibernating: 4009,
} as const;
export type SandboxCloseReason = keyof typeof SANDBOX_CLOSE_CODES;

/** `error` frame codes. */
export const SANDBOX_ERROR_CODES = [
  "malformed_frame",
  "unknown_type",
  "unknown_thread",
  "unknown_run",
  "run_not_active", // the run ended; late frames for it are answered with this, not executed
  "pi_unavailable", // Pi process could not start or exited
  "pi_rejected", // Pi answered success:false
  "model_not_configured", // run.start named no gateway model for a sandbox with model access (KOBE-41)
  "runtime_tampered", // another process changed a Pi's private runtime dir; that Pi was stopped (KOBE-41)
  "frame_too_large",
  "internal",
] as const;
export type SandboxErrorCode = (typeof SANDBOX_ERROR_CODES)[number];
