// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppItemStore } from "./app-items";
import { appMessageOf, attachHostBridge, type AppMessage } from "./host-bridge";
import {
  IDENTIFIER_MAX,
  LAKEHOUSE_DRAG_TYPE,
  URI_MAX,
  carriesLakehouseItem,
  lakehouseItemContent,
} from "./lakehouse-drop";

/**
 * KOBE-551 ac-2, ac-3: a Lakehouse Picker item dragged out of its frame carries the item as JSON.
 * Kobe never trusts it: only a well-formed item becomes the same `ui/message` content a click on
 * the picker sends, and both go through the bridge's one `appMessageOf`.
 */
const TABLE = {
  kind: "table",
  catalog: "mlb",
  namespace: "lahman",
  name: "batting",
  identifier: "mlb.lahman.batting",
  uri: "catalyst://lakehouse/mlb/lahman/batting",
};
const json = (v: unknown) => JSON.stringify(v);

/** What the picker sends on a click today (the drag contract's twin). */
const clickContent = (kind: string, segments: string[]) => [
  { type: "text", text: `\`${segments.join(".")}\`` },
  {
    type: "resource_link",
    uri: `catalyst://lakehouse/${segments.join("/")}`,
    name: segments.join("."),
    title: segments.at(-1),
    _meta: { "io.kobe/item-kind": kind },
  },
];

describe("the drag's types (ac-1)", () => {
  it("is seen by its type name alone, as a protected drag shows it", () => {
    const dt = (types: string[]) => ({ types }) as unknown as DataTransfer;
    expect(carriesLakehouseItem(dt(["text/plain", LAKEHOUSE_DRAG_TYPE]))).toBe(true);
    expect(carriesLakehouseItem(dt(["text/plain"]))).toBe(false);
    expect(carriesLakehouseItem(dt(["Files"]))).toBe(false);
    expect(carriesLakehouseItem(null)).toBe(false);
  });
});

describe("validation (ac-2)", () => {
  it("takes the four kinds, each with its own segments", () => {
    expect(lakehouseItemContent(json(TABLE))).toEqual(
      clickContent("table", ["mlb", "lahman", "batting"]),
    );
    expect(
      lakehouseItemContent(
        json({
          ...TABLE,
          kind: "view",
          name: "v_2",
          identifier: "mlb.lahman.v_2",
          uri: "catalyst://lakehouse/mlb/lahman/v_2",
        }),
      ),
    ).toEqual(clickContent("view", ["mlb", "lahman", "v_2"]));
    expect(
      lakehouseItemContent(
        json({
          kind: "namespace",
          catalog: "mlb",
          namespace: "lahman",
          identifier: "mlb.lahman",
          uri: "catalyst://lakehouse/mlb/lahman",
        }),
      ),
    ).toEqual(clickContent("namespace", ["mlb", "lahman"]));
    expect(
      lakehouseItemContent(
        json({
          kind: "catalog",
          catalog: "mlb",
          identifier: "mlb",
          uri: "catalyst://lakehouse/mlb",
        }),
      ),
    ).toEqual(clickContent("catalog", ["mlb"]));
  });

  it.each([
    ["a kind outside the four", { ...TABLE, kind: "column" }],
    ["a missing kind", { ...TABLE, kind: undefined }],
    [
      "a bad segment",
      {
        ...TABLE,
        name: "Bad Name`",
        identifier: "mlb.lahman.Bad Name`",
        uri: "catalyst://lakehouse/mlb/lahman/Bad Name`",
      },
    ],
    [
      "a segment starting with a digit",
      {
        ...TABLE,
        name: "1x",
        identifier: "mlb.lahman.1x",
        uri: "catalyst://lakehouse/mlb/lahman/1x",
      },
    ],
    ["an identifier that is not the segments", { ...TABLE, identifier: "mlb.lahman.pitching" }],
    [
      "a uri that is not the segments",
      { ...TABLE, uri: "catalyst://lakehouse/mlb/lahman/pitching" },
    ],
    ["a uri of another scheme", { ...TABLE, uri: "https://lakehouse/mlb/lahman/batting" }],
    ["a table without its name", { ...TABLE, name: undefined, identifier: "mlb.lahman" }],
    [
      "a catalog with a namespace",
      {
        ...TABLE,
        kind: "catalog",
        name: undefined,
        identifier: "mlb.lahman",
        uri: "catalyst://lakehouse/mlb/lahman",
      },
    ],
    ["a number for a segment", { ...TABLE, catalog: 7 }],
    ["an array", [TABLE]],
    ["null", null],
  ])("refuses %s", (_label, payload) => {
    expect(lakehouseItemContent(json(payload))).toBeUndefined();
  });

  it("refuses text that is not JSON, and oversized identifiers and uris", () => {
    expect(lakehouseItemContent("")).toBeUndefined();
    expect(lakehouseItemContent("`mlb.lahman.batting`")).toBeUndefined();
    const long = "a".repeat(IDENTIFIER_MAX);
    expect(
      lakehouseItemContent(
        json({
          ...TABLE,
          name: long,
          identifier: `mlb.lahman.${long}`,
          uri: `catalyst://lakehouse/mlb/lahman/${long}`,
        }),
      ),
    ).toBeUndefined();
    expect(URI_MAX).toBe(2047);
    expect(lakehouseItemContent(json({ ...TABLE, pad: "x".repeat(64 * 1024) }))).toBeUndefined();
  });
});

describe("a drop is a click (ac-3)", () => {
  afterEach(() => vi.restoreAllMocks());

  /** The AppMessage the bridge hands the composer for a picker's ui/message. */
  function viaBridge(content: unknown[]): AppMessage {
    const frame = { postMessage: vi.fn() } as unknown as Window;
    const message = vi.fn((_m: AppMessage) => true);
    const bridge = attachHostBridge(window, {
      frame: () => frame,
      handlers: {
        callTool: vi.fn(),
        listTools: vi.fn(),
        message,
        updateModelContext: vi.fn(),
        requestDisplayMode: vi.fn(),
        sizeChanged: vi.fn(),
        initialized: vi.fn(),
      },
      hostContext: () => ({}),
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { jsonrpc: "2.0", id: 1, method: "ui/message", params: { role: "user", content } },
        source: frame,
        origin: "null",
      }),
    );
    bridge.detach();
    return message.mock.calls[0]?.[0] as AppMessage;
  }

  it.each([
    ["table", TABLE, ["mlb", "lahman", "batting"]],
    [
      "namespace",
      {
        kind: "namespace",
        catalog: "mlb",
        namespace: "lahman",
        identifier: "mlb.lahman",
        uri: "catalyst://lakehouse/mlb/lahman",
      },
      ["mlb", "lahman"],
    ],
  ] as const)(
    "the %s's drop and its ui/message give the same composer chips",
    (kind, payload, segments) => {
      const clicked = viaBridge(clickContent(kind, [...segments]));
      const dropped = appMessageOf(lakehouseItemContent(json(payload)) ?? []);
      expect(dropped).toEqual(clicked);
      expect(dropped.items).toEqual([
        { uri: `catalyst://lakehouse/${segments.join("/")}`, name: segments.join("."), kind },
      ]);
      // In the store the composer reads, both end as the same chip.
      const a = new AppItemStore();
      const b = new AppItemStore();
      a.add(
        "t",
        clicked.items.map((i) => ({ ...i, from: "Lakehouse Picker" })),
      );
      b.add(
        "t",
        dropped.items.map((i) => ({ ...i, from: "Lakehouse Picker" })),
      );
      expect(b.snapshot("t")).toEqual(a.snapshot("t"));
    },
  );
});
