import type { SandboxToServerFrame, ServerToSandboxFrame } from "@kobe/protocol";
import type { Logger } from "pino";
import { remember } from "../connection-limits.js";
import { UI_DEDUPE_MAX } from "../constants.js";
import type { SandboxTarget, UiBroker } from "../types.js";

type UiRequestFrame = Extract<SandboxToServerFrame, { type: "pi.ui_request" }>;

/** What a `pi.ui_request` needs from its connection (KOBE-706: moved out of connection.ts). */
export interface UiRequestPort {
  readonly ui: UiBroker;
  readonly target: SandboxTarget;
  /** Requests answered on this connection (`thread:request id`). */
  readonly seen: Set<string>;
  readonly log: Pick<Logger, "warn">;
  /** The frame's run (if named) or thread is leased here; a violation was already handled. */
  leased(frame: UiRequestFrame): boolean;
  send(frame: ServerToSandboxFrame): boolean;
}

/** `pi.ui_request`: Pi asks the member something; answered once, also after a reconnect. */
export function onUiRequest(c: UiRequestPort, frame: UiRequestFrame): void {
  if (!c.leased(frame)) return;
  const key = `${frame.thread_id}:${frame.request.id}`;
  if (c.seen.has(key)) return; // re-sent after a reconnect (KOBE-23): answered once
  remember(c.seen, key, UI_DEDUPE_MAX);
  Promise.resolve()
    .then(() =>
      c.ui.handle({
        target: c.target,
        threadId: frame.thread_id,
        ...(frame.run_id === undefined ? {} : { runId: frame.run_id }),
        request: frame.request,
      }),
    )
    .then((response) => {
      if (response) c.send({ v: 1, type: "pi.ui_response", thread_id: frame.thread_id, response });
    })
    .catch((err: unknown) => c.log.warn({ err }, "ui request handling failed"));
}
