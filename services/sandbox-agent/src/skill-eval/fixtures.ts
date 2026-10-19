import { Readable } from "node:stream";
import { SKILL_EVAL_FIXTURES_PATH, type EvalPrepareFrame } from "@kobe/protocol";
import { writeFileAtomic } from "../workspace/fs.js";

// A skill eval case's fixtures into its empty workspace (KOBE-325): fetched one by one from the
// server's sandbox listener with the sandbox's own token (the server serves only this eval
// sandbox's case), each checked against the size and SHA-256 the server listed, written without
// following any link (`writeFileAtomic`: exclusive temp file, verified, renamed).

/** Group-shared like every workspace file: each Pi identity reads and writes through the group. */
const FIXTURE_MODE = 0o664;

export type FixtureFetcher = (path: string, size: number) => Promise<Uint8Array>;

export interface FixtureClientOptions {
  /** KOBE_SERVER_URL (ws:// or wss://). */
  readonly serverUrl: string;
  readonly readToken: () => Promise<string>;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

export function fixtureUrl(serverUrl: string, rel: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = SKILL_EVAL_FIXTURES_PATH;
  url.search = new URLSearchParams({ path: rel }).toString();
  return url.toString();
}

export function createFixtureFetcher(options: FixtureClientOptions): FixtureFetcher {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  return async (rel, size) => {
    const token = await options.readToken();
    const res = await doFetch(fixtureUrl(options.serverUrl, rel), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`the server answered ${res.status} for a fixture`);
    }
    const reader = res.body?.getReader();
    if (!reader) throw new Error("empty fixture response");
    const chunks: Uint8Array[] = [];
    let seen = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.length;
      if (seen > size) {
        await reader.cancel();
        throw new Error("the fixture is larger than listed");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  };
}

export async function prepareFixtures(
  workspace: string,
  frame: Pick<EvalPrepareFrame, "files">,
  fetchFixture: FixtureFetcher,
  now: () => number = () => Date.now(),
): Promise<void> {
  for (const file of frame.files) {
    const bytes = await fetchFixture(file.path, file.size);
    await writeFileAtomic(workspace, file.path, Readable.from([Buffer.from(bytes)]), {
      sha256: file.sha256,
      size: file.size,
      mtimeMs: now(),
      mode: FIXTURE_MODE,
    });
  }
}
