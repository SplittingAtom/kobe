// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { frameDragRelay } from "../../lib/apps/frame-drag";
import {
  attachHostBridge,
  type HostBridge,
  type HostBridgeHandlers,
} from "../../lib/apps/host-bridge";
import { lakehouseItemContent } from "../../lib/apps/lakehouse-drop";
import { createChatApi } from "../../lib/chat/api";
import { NEW_DRAFT } from "../../lib/chat/attachments";
import { ChatSession } from "../../lib/chat/session";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { applyAppMessage } from "../apps/use-app-composer";
import { watchFrameDrop } from "./composer-frame-drop";
import { insertLakehouseItem } from "./composer-mention-drop";

/**
 * KOBE-553 ac-5: a bridge drag-end on the composer and a `ui/message` carrying the same
 * resource_link (the click's content) leave the same chip store snapshot.
 */
const TABLE = {
  kind: "table",
  catalog: "mlb",
  namespace: "lahman",
  name: "batting",
  identifier: "mlb.lahman.batting",
  uri: "catalyst://lakehouse/mlb/lahman/batting",
};
const FROM = "Lakehouse Picker";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function harness(handlersOf: (session: ChatSession) => Partial<HostBridgeHandlers>) {
  const fake = new FakeKobe();
  const session = new ChatSession({
    teamId: fake.teamId,
    api: createChatApi(fake.teamId, fake.fetch),
  });
  const handlers = handlersOf(session);
  const frame = { postMessage: vi.fn() } as unknown as Window;
  const bridge: HostBridge = attachHostBridge(window, {
    frame: () => frame,
    hostContext: () => ({}),
    handlers: {
      callTool: vi.fn(),
      listTools: vi.fn(),
      message: () => false,
      updateModelContext: () => false,
      requestDisplayMode: (m) => m,
      sizeChanged: vi.fn(),
      initialized: vi.fn(),
      ...handlers,
    },
  });
  cleanups.push(() => {
    bridge.detach();
    session.dispose();
  });
  const send = (data: unknown) =>
    window.dispatchEvent(new MessageEvent("message", { data, source: frame, origin: "null" }));
  return { session, send };
}

describe("drag-end and ui/message are equivalent (KOBE-553 ac-5)", () => {
  it("produce the same chip store snapshot", async () => {
    const click = harness((session) => ({
      message: (m) => applyAppMessage(session, NEW_DRAFT, m, FROM),
    }));
    click.send({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/message",
      params: { role: "user", content: lakehouseItemContent(JSON.stringify(TABLE)) },
    });
    await new Promise((r) => setTimeout(r, 0));

    const notices: string[] = [];
    const drag = harness((session) => {
      const relay = frameDragRelay(session.frameDrag);
      cleanups.push(
        watchFrameDrop(session.frameDrag, {
          inside: () => true,
          over: () => undefined,
          drop: (d) => notices.push(insertLakehouseItem(session, NEW_DRAFT, d.item, d.from) ?? ""),
        }),
      );
      return { drag: (e) => relay(e, FROM) };
    });
    drag.send({
      jsonrpc: "2.0",
      method: "kobe/notifications/drag-start",
      params: { item: TABLE, x: 1, y: 1 },
    });
    drag.send({ jsonrpc: "2.0", method: "kobe/notifications/drag-end", params: { x: 2, y: 2 } });

    expect(notices).toEqual([""]);
    const clicked = click.session.appItems.snapshot(NEW_DRAFT);
    expect(clicked.items).toHaveLength(1);
    expect(drag.session.appItems.snapshot(NEW_DRAFT)).toEqual(clicked);
  });
});
