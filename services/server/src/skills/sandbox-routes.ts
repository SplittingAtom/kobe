import { Readable } from "node:stream";
import { withTeam, type KobeDb } from "@kobe/db";
import { sha256HexSchema } from "@kobe/protocol";
import { Hono } from "hono";
import type { Logger } from "pino";
import { createRateLimiter, type RateLimiter } from "../sandbox/rate-limit.js";
import type { BlobStore } from "../retention/blobs.js";
import type { SandboxAuthenticator } from "../workspace-sync/auth.js";
import { IntegrityError, verifyingStream } from "../workspace-sync/object-store.js";
import { locateBundle } from "./materialize.js";

/** Bundle downloads per sandbox: a run start fetches at most a few dozen, then a steady trickle. */
export const SKILL_FETCH_RATE = { capacity: 200, refillPerSecond: 20 } as const;

export interface SkillSandboxRoutesDeps {
  readonly db: KobeDb;
  readonly blobs: BlobStore;
  readonly authenticate: SandboxAuthenticator;
  readonly log: Pick<Logger, "error" | "warn">;
  readonly limiter?: RateLimiter;
}

const notFound = () =>
  new Response(
    JSON.stringify({ code: "not_found", message: "No such skill bundle for this sandbox." }),
    { status: 404, headers: { "content-type": "application/json" } },
  );

/**
 * `GET /<sha256>` on the sandbox listener (contract: packages/protocol sandbox-wire/skill-bundles.ts,
 * KOBE-82). The caller is a live sandbox (`kobe.sandbox-wire` token, same checks as workspace sync);
 * (team, user) come from the token. The bundle is served only while that hash is effective for
 * that user in that team (re-checked now, blocklist included, in one transaction), streamed from
 * the object store with its hash verified on the way. Everything else, including a blocklisted or
 * unapproved hash, is the same 404: the sandbox learns nothing about what exists.
 */
export function skillSandboxRoutes(deps: SkillSandboxRoutesDeps): Hono {
  const { db, blobs, authenticate, log, limiter = createRateLimiter(SKILL_FETCH_RATE) } = deps;
  const app = new Hono();
  app.get("/:sha256", async (c) => {
    const auth = await authenticate(c.req.header("authorization"));
    if (!auth.ok) {
      return c.json({ code: "unauthorized", message: "Not a live sandbox." }, 401);
    }
    const { caller } = auth;
    const wait = limiter.take(caller.sandboxId);
    if (wait > 0) {
      return c.json({ code: "rate_limited", message: "Too many requests." }, 429, {
        "retry-after": String(Math.ceil(wait / 1000)),
      });
    }
    const hash = sha256HexSchema.safeParse(c.req.param("sha256"));
    if (!hash.success) return notFound();
    const found = await withTeam(db, caller.teamId, (tx) =>
      locateBundle(tx, { teamId: caller.teamId, userId: caller.userId }, hash.data),
    );
    if (!found) return notFound();
    const object = await blobs.objects.get(found.storageKey);
    if (!object || object.size !== found.size) {
      log.error({ hash: hash.data }, "skills: effective bundle is missing or the wrong size");
      return c.json({ code: "unavailable", message: "The bundle is not available." }, 503);
    }
    const verified = object.body.pipe(verifyingStream(hash.data, found.size));
    object.body.on("error", (err) => verified.destroy(err));
    verified.on("error", (err) => {
      if (err instanceof IntegrityError) {
        log.error({ hash: hash.data, reason: err.reason }, "skills: stored bundle is corrupt");
      }
    });
    return new Response(Readable.toWeb(verified) as ReadableStream, {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-length": String(found.size),
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  });
  return app;
}
