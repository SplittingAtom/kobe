import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpBifrostAdmin } from "./bifrost-admin.js";
import { buildDesiredState, virtualKeyName, type ProviderInput } from "./desired.js";
import { reconcile } from "./reconcile.js";

/**
 * A Bifrost upgrade on a kept store (KOBE-600): the previous pinned binary syncs Kobe's state
 * (providers, keys, customer, teams, virtual keys with a request rate), then the new binary starts
 * on the same `config.db` and runs its store migrations (v2.3.0 moves virtual-key rate limits onto
 * model-config tiers). The sync must find nothing to change, the virtual keys must keep their ids
 * and values, and the rate limit must still read back and still be enforced. Opt-in:
 * KOBE_TEST_BIFROST_BIN (new) and KOBE_TEST_BIFROST_BIN_PREVIOUS (old) point at bifrost-http
 * binaries (the image's /app/main is static).
 */
const BIN = process.env.KOBE_TEST_BIFROST_BIN;
const PREVIOUS = process.env.KOBE_TEST_BIFROST_BIN_PREVIOUS;
const PASSWORD = "integration-admin-password-0001";
const logger = pino({ level: "silent" });

function fakeOpenAi(): Server {
  return createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const body = req.url?.includes("/chat/completions")
        ? {
            id: "c1",
            object: "chat.completion",
            created: 1,
            model: "m",
            choices: [
              { index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }
        : { object: "list", data: [] };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
  });
}

async function startBifrost(bin: string, dir: string, port: number): Promise<ChildProcess> {
  const child = spawn(bin, ["-app-dir", dir, "-port", String(port), "-host", "127.0.0.1"], {
    env: {
      ...process.env,
      BIFROST_ENCRYPTION_KEY: "integration-encryption-key-0001",
      BIFROST_ADMIN_USERNAME: "kobe",
      BIFROST_ADMIN_PASSWORD: PASSWORD,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const ok = await fetch(`http://127.0.0.1:${port}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return child;
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill("SIGTERM");
  throw new Error(`bifrost (${bin}) did not start`);
}

async function stopBifrost(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((r) => {
    child.once("exit", () => r());
    child.kill("SIGTERM");
  });
}

describe.skipIf(!BIN || !PREVIOUS)("Bifrost upgrade on a kept store", () => {
  let dir = "";
  let upstream: Server;
  let up = "";
  let bifrost: ChildProcess | undefined;

  beforeAll(async () => {
    upstream = fakeOpenAi();
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    up = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    dir = mkdtempSync(join(tmpdir(), "kobe-bifrost-upgrade-"));
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        encryption_key: "env.BIFROST_ENCRYPTION_KEY",
        client: {
          enforce_auth_on_inference: true,
          enable_logging: false,
          disable_content_logging: true,
          allow_direct_keys: false,
        },
        governance: {
          auth_config: {
            admin_username: "env.BIFROST_ADMIN_USERNAME",
            admin_password: "env.BIFROST_ADMIN_PASSWORD",
            is_enabled: true,
          },
        },
        config_store: { enabled: true, type: "sqlite", config: { path: join(dir, "config.db") } },
        logs_store: { enabled: false },
      }),
    );
  });

  afterAll(async () => {
    if (bifrost) await stopBifrost(bifrost);
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps virtual keys and their rate limits through the store migration", async () => {
    const teamId = randomUUID();
    const members = [randomUUID(), randomUUID()];
    const providers: ProviderInput[] = [
      { id: "openai", kind: "openai", baseUrl: up, allowPrivateNetwork: true, apiKey: "up-openai" },
    ];
    const catalog = [{ alias: "fast", providerId: "openai", model: "gpt-x" }];
    const desired = (requestsPerMinute: number) =>
      buildDesiredState(
        { providers, catalog, teams: [{ teamId, members, aliases: ["fast"], requestsPerMinute }] },
        "f".repeat(40),
      );

    // The previous version syncs Kobe's state.
    const oldPort = 18000 + Math.floor(Math.random() * 1000);
    bifrost = await startBifrost(PREVIOUS ?? "", dir, oldPort);
    const oldAdmin = createHttpBifrostAdmin({
      baseUrl: `http://127.0.0.1:${oldPort}`,
      username: "kobe",
      password: PASSWORD,
    });
    const before = await reconcile(desired(2), oldAdmin, logger);
    expect(before.errors).toEqual([]);
    const keysBefore = await oldAdmin.listVirtualKeys();
    expect(keysBefore.map((k) => k.requestsPerMinute)).toEqual([2, 2]);
    await stopBifrost(bifrost);

    // The new version migrates the same store.
    const port = 19000 + Math.floor(Math.random() * 1000);
    const base = `http://127.0.0.1:${port}`;
    bifrost = await startBifrost(BIN ?? "", dir, port);
    const admin = createHttpBifrostAdmin({ baseUrl: base, username: "kobe", password: PASSWORD });
    const sortById = <T extends { id: string }>(a: T[]) =>
      [...a].sort((x, y) => x.id.localeCompare(y.id));
    expect(sortById(await admin.listVirtualKeys())).toEqual(sortById(keysBefore));
    const after = await reconcile(desired(2), admin, logger);
    expect(after.errors).toEqual([]);
    expect(after.changes).toBe(0);
    expect(after.virtualKeys).toEqual(before.virtualKeys);

    const vk = before.virtualKeys.get(virtualKeyName(teamId, members[0] ?? ""))?.value ?? "";
    const chat = () =>
      fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bf-vk": vk },
        body: JSON.stringify({ model: "openai/gpt-x", messages: [{ role: "user", content: "x" }] }),
      }).then(async (r) => ({ status: r.status, text: await r.text() }));
    expect((await chat()).status).toBe(200);
    expect((await chat()).status).toBe(200);
    const third = await chat();
    expect(third.status).toBe(429);
    expect(third.text).toContain("rate");

    // A changed rate is still an update after the migration, reads back, then converges.
    const raised = await reconcile(desired(100), admin, logger);
    expect(raised.errors).toEqual([]);
    expect(raised.changes).toBeGreaterThan(0);
    expect((await admin.listVirtualKeys()).map((k) => k.requestsPerMinute)).toEqual([100, 100]);
    expect((await reconcile(desired(100), admin, logger)).changes).toBe(0);
  }, 180_000);
});
