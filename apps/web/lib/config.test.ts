import { describe, expect, it } from "vitest";
import { parseWebConfig } from "./config";

/** KOBE-500: KOBE_SERVER_URL is validated, origin only, and never fails the web's start. */
describe("parseWebConfig", () => {
  it("accepts an http(s) origin and normalises a trailing slash away", () => {
    expect(parseWebConfig({ KOBE_SERVER_URL: "http://kobe-server" })).toEqual({
      serverUrl: "http://kobe-server",
      problem: null,
    });
    expect(parseWebConfig({ KOBE_SERVER_URL: "https://kobe-server.ns.svc:8443/" }).serverUrl).toBe(
      "https://kobe-server.ns.svc:8443",
    );
  });

  it("reports a missing value instead of throwing", () => {
    for (const env of [{}, { KOBE_SERVER_URL: "" }, { KOBE_SERVER_URL: "  " }]) {
      const config = parseWebConfig(env);
      expect(config.serverUrl).toBeNull();
      expect(config.problem).toMatch(/KOBE_SERVER_URL is not set/);
    }
  });

  it.each([
    "kobe-server",
    "ftp://kobe-server",
    "http://kobe-server/v1",
    "http://kobe-server?x=1",
    "http://user:pw@kobe-server",
    "javascript:alert(1)",
  ])("refuses %s with a reason", (value) => {
    const config = parseWebConfig({ KOBE_SERVER_URL: value });
    expect(config.serverUrl).toBeNull();
    expect(config.problem).toMatch(/KOBE_SERVER_URL is invalid/);
  });
});
