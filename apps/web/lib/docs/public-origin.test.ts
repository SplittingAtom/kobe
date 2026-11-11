import { describe, expect, it } from "vitest";
import { publicOrigin } from "./public-origin";

/** KOBE-616: the origin in front of the guide's Markdown links. */
describe("publicOrigin", () => {
  const req = (headers: Record<string, string>) =>
    new Request("http://0.0.0.0:8080/llms.txt", { headers });

  it("prefers the configured public URL", () => {
    expect(publicOrigin(req({ host: "evil.example" }), "https://kobe.example.com")).toBe(
      "https://kobe.example.com",
    );
  });
  it("uses the forwarded host and proto, then Host", () => {
    expect(
      publicOrigin(
        req({ "x-forwarded-host": "Kobe.Example.com", "x-forwarded-proto": "https" }),
        null,
      ),
    ).toBe("https://kobe.example.com");
    expect(publicOrigin(req({ host: "localhost:3000" }), null)).toBe("http://localhost:3000");
  });
  it("ignores a host that is not a plain host[:port]", () => {
    expect(publicOrigin(req({ "x-forwarded-host": "a.com/evil) [x](y" }), null)).toBe(
      "http://0.0.0.0:8080",
    );
  });
});
