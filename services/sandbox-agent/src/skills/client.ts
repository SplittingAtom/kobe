import { SKILL_BUNDLE_PATH } from "@kobe/protocol";
import type { BundleFetcher } from "./store.js";

/**
 * Downloads a skill bundle from the server's sandbox listener (contract: packages/protocol
 * sandbox-wire/skill-bundles.ts), authenticated with the sandbox's wire token, like workspace sync.
 * The sandbox holds no object-store credentials and names no storage key: it asks for a hash, the
 * server serves it only while it is effective for this sandbox's user and team. At most `size`
 * bytes are read, so a misbehaving server can't fill memory.
 */
export interface SkillClientOptions {
  /** KOBE_SERVER_URL (ws:// or wss://). */
  readonly serverUrl: string;
  readonly readToken: () => Promise<string>;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

export function skillBundleUrl(serverUrl: string, sha256: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = `${SKILL_BUNDLE_PATH}/${sha256}`;
  url.search = "";
  return url.toString();
}

export function createSkillFetcher(options: SkillClientOptions): BundleFetcher {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  return async (sha256, size) => {
    const token = await options.readToken();
    const res = await doFetch(skillBundleUrl(options.serverUrl, sha256), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) {
      await res.body?.cancel();
      throw new Error("the server does not offer this bundle (no longer effective?)");
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`the server answered ${res.status}`);
    }
    return readExactly(res, size);
  };
}

async function readExactly(res: Response, size: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? size);
  if (declared !== size) {
    await res.body?.cancel();
    throw new Error("the bundle's size differs from the one listed");
  }
  const chunks: Uint8Array[] = [];
  let seen = 0;
  const reader = res.body?.getReader();
  if (!reader) throw new Error("empty response");
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.length;
    if (seen > size) {
      await reader.cancel();
      throw new Error("the bundle is larger than listed");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
