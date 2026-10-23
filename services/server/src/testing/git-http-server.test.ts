import { afterEach, describe, expect, it } from "vitest";
import { startGitServer, type GitServer } from "./git-http-server.js";

/**
 * KOBE-480: `git http-backend` can exit before it reads the whole request body; writing the
 * rest of the body then fails with EPIPE, which used to surface as an unhandled error in CI.
 */
describe("git test server", () => {
  let server: GitServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("answers a large POST that git refuses without reading it, with no unhandled EPIPE", async () => {
    server = await startGitServer();
    // No such repository: http-backend answers 404 and exits without reading stdin. The body is
    // far larger than a pipe buffer, so the write to its stdin fails with EPIPE.
    const body = Buffer.alloc(4 * 1024 * 1024, 0x30);
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${server.origin}/missing.git/git-receive-pack`, {
        method: "POST",
        headers: { "content-type": "application/x-git-receive-pack-request" },
        body,
      });
      expect(res.status).toBe(404);
      await res.arrayBuffer();
    }
  });

  it("closes while a request is still being served", async () => {
    server = await startGitServer();
    server.repo("r");
    const pending = fetch(`${server.origin}/r.git/info/refs?service=git-upload-pack`).catch(
      () => undefined,
    );
    await server.close();
    server = undefined;
    await pending;
  });
});
