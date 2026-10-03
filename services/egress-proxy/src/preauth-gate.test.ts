import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { PreAuthGate } from "./preauth-gate.js";

function fakeSocket(remoteAddress: string): Socket & { destroyed: boolean } {
  const s = new EventEmitter() as unknown as Socket & { destroyed: boolean };
  Object.assign(s, { remoteAddress, destroyed: false });
  s.destroy = (() => {
    s.destroyed = true;
    s.emit("close");
    return s;
  }) as Socket["destroy"];
  return s;
}

describe("PreAuthGate", () => {
  it("caps pending sockets per source, so one sandbox's flood leaves others alone", () => {
    const gate = new PreAuthGate({ perSource: 2, total: 100 });
    const flood = Array.from({ length: 50 }, () => fakeSocket("10.42.0.5"));
    expect(flood.map((s) => gate.admit(s)).filter(Boolean)).toHaveLength(2);
    expect(flood.filter((s) => s.destroyed)).toHaveLength(48);
    expect(gate.admit(fakeSocket("10.42.0.6"))).toBe(true);
    expect(gate.drainRefused()).toBe(48);
  });

  it("caps the total and frees slots on authentication or close", () => {
    const gate = new PreAuthGate({ perSource: 10, total: 2 });
    const a = fakeSocket("a");
    const b = fakeSocket("b");
    expect(gate.admit(a) && gate.admit(b)).toBe(true);
    expect(gate.admit(fakeSocket("c"))).toBe(false);
    gate.authenticated(a);
    gate.authenticated(a);
    expect(gate.pending()).toBe(1);
    b.destroy();
    expect(gate.pending()).toBe(0);
    expect(gate.admit(fakeSocket("c"))).toBe(true);
  });
});
