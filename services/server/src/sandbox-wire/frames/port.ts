import type { ServerToSandboxFrame } from "@kobe/protocol";
import type { Logger } from "pino";
import type { WireContext } from "../context.js";
import type { SandboxTarget } from "../types.js";

/** The narrow view of one sandbox connection that its frame handlers get (KOBE-706). */
export interface ConnectionPort {
  readonly ctx: WireContext;
  readonly target: SandboxTarget;
  readonly sandboxId: string;
  readonly connectionId: string;
  /** The connection's logger (connection and team bound). */
  readonly log: Logger;
  send(frame: ServerToSandboxFrame): boolean;
}
