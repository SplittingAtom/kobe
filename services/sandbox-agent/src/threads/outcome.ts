import type { SandboxErrorCode } from "@kobe/protocol";

/** Result of one server command; becomes exactly one `command.result` frame. */
export type CommandOutcome =
  | { readonly ok: true; readonly data?: unknown }
  | { readonly ok: false; readonly code: SandboxErrorCode; readonly message: string };

export const ok = (data?: unknown): CommandOutcome =>
  data === undefined ? { ok: true } : { ok: true, data };

export const fail = (code: SandboxErrorCode, message: string): CommandOutcome => ({
  ok: false,
  code,
  message: message.slice(0, 2000),
});
