import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  SecretBox,
  VIRTUAL_KEY_PURPOSE,
  createDb,
  eq,
  and,
  isRunLeasedTo,
  loadGatewayPrincipal,
  modelGatewayKeys,
  sandboxes,
  teamMembers,
  teams,
  users,
  virtualKeyContext,
  withTeam,
  type KobeDatabase,
} from "@kobe/db";
import { signSessionToken, verifySessionToken } from "@kobe/session-token";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createModelGateway } from "./gateway.js";
import { CallLimiter } from "./limits.js";
import { PrincipalCache } from "./principals.js";
import { OPEN_GATE } from "./seams.js";

/**
 * KOBE-40 ac-2 at integration level: the shim with its real Postgres principal store. A live
 * member's sandbox token reaches Bifrost (faked) with the member's sealed virtual key; once the
 * member is removed, deactivated, or the sandbox destroyed, the same (still unexpired) token is
 * refused.
 */
const KEY = "m".repeat(40);
const box = new SecretBox("v".repeat(40), VIRTUAL_KEY_PURPOSE);
const team = randomUUID();
const other = randomUUID();
const user = randomUUID();
const sandboxId = randomUUID();
const VK = `sk-bf-${randomUUID()}`;
let app: KobeDatabase;
let bifrost: Server;
let shim: Server;
let base = "";
const seenVks: string[] = [];

const token = (teamId = team) => {
  const now = Math.floor(Date.now() / 1000);
  return signSessionToken(
    {
      iss: "kobe-server",
      aud: "kobe.model-gateway",
      sub: sandboxId,
      team_id: teamId,
      user_id: user,
      iat: now,
      exp: now + 900,
      jti: randomUUID().replace(/-/g, ""),
    },
    KEY,
  );
};
const chat = (t: string) =>
  fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "openai/gpt-x", messages: [] }),
  }).then((r) => r.status);

beforeAll(async () => {
  const owner = createDb(inject("ownerUrl"));
  await owner.db.insert(teams).values([
    { id: team, slug: `g-${team.slice(0, 8)}`, name: "Gateway" },
    { id: other, slug: `o-${other.slice(0, 8)}`, name: "Other" },
  ]);
  await owner.close();
  app = createDb(inject("appUrl"));
  await app.db.insert(users).values({ id: user, name: "G", email: `${user}@g.test` });
  await withTeam(app.db, team, async (tx) => {
    await tx.insert(teamMembers).values({ teamId: team, userId: user, role: "member" });
    await tx.insert(sandboxes).values({ teamId: team, userId: user, sandboxId, state: "running" });
    await tx.insert(modelGatewayKeys).values({
      teamId: team,
      userId: user,
      vkId: "vk-1",
      vkValueEnc: box.seal(VK, virtualKeyContext(team, user)),
    });
  });
  bifrost = createServer((req, res) => {
    seenVks.push(String(req.headers["x-bf-vk"]));
    req.resume();
    req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end("{}"));
  });
  await new Promise<void>((r) => bifrost.listen(0, "127.0.0.1", r));
  const db = app.db;
  shim = createModelGateway({
    verify: (t) => verifySessionToken(t, "kobe.model-gateway", KEY),
    principals: new PrincipalCache(
      {
        load: (t, u, s) => loadGatewayPrincipal(db, t, u, s),
        requestKey: async () => undefined,
      },
      box,
      { ttlMs: 0, keyWaitMs: 100, keyPollMs: 20 },
    ),
    isRunLeased: (t, r, s) => isRunLeasedTo(db, t, r, s),
    bifrostUrl: `http://127.0.0.1:${(bifrost.address() as AddressInfo).port}`,
    limiter: new CallLimiter({ perSandbox: 4, total: 16 }),
    gate: OPEN_GATE,
    sink: { record: () => undefined },
    onBifrostForgotKey: () => undefined,
    logger: pino({ level: "silent" }),
    settings: { maxBodyBytes: 65_536, idleTimeoutMs: 5_000 },
    ready: () => true,
  });
  await new Promise<void>((r) => shim.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(shim.address() as AddressInfo).port}`;
});
afterAll(async () => {
  shim.closeAllConnections();
  await new Promise<void>((r) => shim.close(() => r()));
  await new Promise<void>((r) => bifrost.close(() => r()));
  await app.close();
});

describe("model gateway with its Postgres principal store", () => {
  it("a live member's sandbox token reaches Bifrost with the member's virtual key", async () => {
    expect(await chat(token())).toBe(200);
    expect(seenVks).toEqual([VK]);
  });

  it("a token naming another team (where the user is no member) is refused", async () => {
    expect(await chat(token(other))).toBe(401);
  });

  it("revocation: hibernated or destroyed sandbox, removed member — the same token stops", async () => {
    const t = token();
    const setState = (state: "running" | "hibernated") =>
      withTeam(app.db, team, (tx) =>
        tx
          .update(sandboxes)
          .set({ state })
          .where(and(eq(sandboxes.teamId, team), eq(sandboxes.userId, user))),
      );
    await setState("hibernated");
    expect(await chat(t)).toBe(401);
    await setState("running");
    expect(await chat(t)).toBe(200);
    await withTeam(app.db, team, (tx) =>
      tx.delete(teamMembers).where(and(eq(teamMembers.teamId, team), eq(teamMembers.userId, user))),
    );
    expect(await chat(t)).toBe(401);
    expect(seenVks).toHaveLength(2);
  });
});
