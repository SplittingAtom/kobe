/**
 * Sandbox ↔ server connection contract (D13). Consumers: KOBE-23 (kobe-sandbox-agent), KOBE-24
 * (server registry and routing), KOBE-36 (kobe-policy), KOBE-41 (model wiring), KOBE-62 (MCP wiring).
 *
 * Transport
 * - The sandbox dials out; sandboxes accept no inbound connections. One WebSocket per sandbox
 *   process, `wss://<server-internal-host>` + {@link SANDBOX_WS_PATH} (in-cluster TLS or a service-
 *   mesh hop is a deployment concern; the path is the contract).
 * - Auth: the per-sandbox **session token** in `Authorization: Bearer <token>` on the upgrade request
 *   (never in the URL: URLs end up in logs). The same token is what the sandbox presents to Bifrost
 *   and the MCP proxy; it is not a provider key or connector credential. The server derives
 *   (team_id, user_id, sandbox_id) from the token; `hello.sandbox_id` must match or the server
 *   closes with {@link SANDBOX_CLOSE_CODES}.unauthorized.
 * - Subprotocol: `Sec-WebSocket-Protocol: kobe.sandbox.v1`. Text frames only, one JSON object per
 *   frame, at most {@link SANDBOX_MAX_FRAME_BYTES} UTF-8 bytes. Every frame has `v` and `type`.
 *
 * Session
 * 1. Sandbox sends `hello` within {@link SANDBOX_HELLO_TIMEOUT_MS} of the upgrade.
 * 2. Server answers `hello.ack` (or closes). A newer connection for the same sandbox replaces the
 *    older one (old one closed with `replaced`), so exactly one socket per sandbox is live.
 * 3. Either side sends `ping`; the other answers `pong` with the same nonce. No frame for
 *    {@link SANDBOX_HEARTBEAT_TIMEOUT_MS} → the connection is dead (server: runs on it may become
 *    `interrupted` once the sandbox is also not reconnecting within the grace period, KOBE-26).
 *
 * Delivery and resume
 * - Sandbox → server `pi.event` frames carry `run_id` and an outbound `seq` (per run, from 1,
 *   gapless, assigned by kobe-sandbox-agent). The server persists, then acks with `ack` (cumulative:
 *   "everything up to seq N of run R is durable"). The agent keeps un-acked frames in memory.
 * - On reconnect `hello.runs` lists the agent's live runs and their highest sent seq; `hello.ack`
 *   returns the server's last durable seq per run; the agent re-sends the gap. Runs the server does
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
  "pi_unavailable", // Pi process could not start or exited
  "pi_rejected", // Pi answered success:false
  "frame_too_large",
  "internal",
] as const;
export type SandboxErrorCode = (typeof SANDBOX_ERROR_CODES)[number];
