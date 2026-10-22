import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { skillPackageHashes } from "@kobe/protocol/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  selfSignedCert,
  startConnectProxy,
  startGitServer,
  type GitServer,
} from "../../testing/git-http-server.js";
import { MirrorSession } from "./git-mirror.js";
import { MirrorHttpError, mirrorHttpClient } from "./http-client.js";

const CREDS = { username: "x-access-token", token: "tok-over-proxy" };
const enc = (s: string) => new TextEncoder().encode(s);
let server: GitServer;
let cert: { key: string; cert: string };
let proxy: Awaited<ReturnType<typeof startConnectProxy>>;
const dirs: string[] = [];

beforeAll(async () => {
  cert = selfSignedCert("localhost");
  server = await startGitServer({ credentials: CREDS, tls: cert });
  proxy = await startConnectProxy({
    accept: (auth, target) => auth === "Bearer site-token" && target.startsWith("localhost:"),
    upstreamPort: Number(new URL(server.origin).port),
  });
});
afterAll(async () => {
  proxy.close();
  await server.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("mirrorHttpClient (KOBE-343)", () => {
  it("pushes over TLS through the egress proxy with a site token (ac-4)", async () => {
    const url = server.repo("proxied");
    const dir = mkdtempSync(path.join(tmpdir(), "kobe-mirror-proxy-"));
    dirs.push(dir);
    const http = mirrorHttpClient({
      remote: url,
      credentials: CREDS,
      proxy: { url: proxy.url, token: () => "site-token" },
      ca: cert.cert,
    });
    const files = new Map([["SKILL.md", enc("---\nname: p\ndescription: d\n---\n")]]);
    const s = await MirrorSession.open(
      { url, branch: "main", http, author: { name: "Kobe", email: "k@kobe.invalid" } },
      dir,
    );
    const r = await s.mirror({
      registryVersionId: "44444444-4444-4444-8444-444444444444",
      name: "p",
      semver: "1.0.0",
      files,
      ...skillPackageHashes(files),
    });
    expect(server.git("proxied", ["rev-parse", "p/v1.0.0^{commit}"], { bare: true }).trim()).toBe(
      r.commit,
    );
    expect(proxy.connects.length).toBeGreaterThan(0);
    expect(proxy.connects.every((t) => t === `localhost:${new URL(server.origin).port}`)).toBe(
      true,
    );
  });

  it("reports the proxy's refusal, and refuses other origins and plain http", async () => {
    const url = server.repo("refused");
    const http = mirrorHttpClient({
      remote: url,
      credentials: CREDS,
      proxy: { url: proxy.url, token: () => "wrong" },
      ca: cert.cert,
    });
    await expect(
      http.request({ url: `${url}/info/refs?service=git-receive-pack` }),
    ).rejects.toThrow(/egress proxy refused localhost: 403/);
    await expect(
      http.request({ url: "https://elsewhere.example.org/x.git/info/refs" }),
    ).rejects.toThrow(MirrorHttpError);
    expect(() =>
      mirrorHttpClient({ remote: "http://git.example.org/c.git", credentials: null, proxy: null }),
    ).toThrow(/https/);
  });
});
